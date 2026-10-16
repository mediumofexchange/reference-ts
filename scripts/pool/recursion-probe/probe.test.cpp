// Probe (reference-ts slice 43, disposable): does a recursive Ultra-ZK Honk verification over a proof whose
// final KZG quotient W was chosen to put the inner PCS pairing point P0 at infinity yield an outer proof that
// bb's native verifier accepts? The inner circuit carries DefaultIO's default (infinity) pairing points, as
// pool-v3 statement circuits and the exhaustion leaves do. Controls: the honest proof, and W moved off the honest
// value without reaching infinity.
#include "barretenberg/circuit_checker/circuit_checker.hpp"
#include "barretenberg/commitment_schemes/shplonk/shplemini.hpp"
#include "barretenberg/common/test.hpp"
#include "barretenberg/flavor/flavor.hpp"
#include "barretenberg/flavor/test_utils/proof_structures.hpp"
#include "barretenberg/flavor/ultra_zk_recursive_flavor.hpp"
#include "barretenberg/honk/proof_length.hpp"
#include "barretenberg/stdlib/special_public_inputs/special_public_inputs.hpp"
#include "barretenberg/sumcheck/sumcheck.hpp"
#include "barretenberg/ultra_honk/oink_verifier.hpp"
#include "barretenberg/ultra_honk/ultra_prover.hpp"
#include "barretenberg/ultra_honk/ultra_verifier.hpp"
#include <fstream>

namespace bb::stdlib::recursion::honk {

using RecursiveFlavor = UltraZKRecursiveFlavor_<UltraCircuitBuilder>;
using InnerFlavor = RecursiveFlavor::NativeFlavor; // UltraZKFlavor
using InnerBuilder = InnerFlavor::CircuitBuilder;
using InnerProver = UltraProver_<InnerFlavor>;
using InnerProverInstance = ProverInstance_<InnerFlavor>;
using InnerVK = InnerFlavor::VerificationKey;
using InnerVerifier = UltraVerifier_<InnerFlavor, bb::DefaultIO>;
using OuterBuilder = UltraCircuitBuilder;
using OuterFlavor = UltraZKFlavor; // Noir's HONK_ZK verifier target proves recursive circuits under Ultra-ZK too
using OuterProver = UltraProver_<OuterFlavor>;
using OuterProverInstance = ProverInstance_<OuterFlavor>;
using OuterVerifier = UltraVerifier_<OuterFlavor, bb::DefaultIO>;
using RecursiveVerifier = UltraVerifier_<RecursiveFlavor, DefaultIO<OuterBuilder>>;
using FF = InnerFlavor::FF;
using Commitment = InnerFlavor::Commitment;
using Proof = std::vector<FF>;

namespace {

InnerBuilder inner_circuit()
{
    InnerBuilder builder;
    for (size_t i = 0; i < 1024; ++i) {
        fr a = fr::random_element();
        fr b = fr::random_element();
        fr c = fr::random_element();
        fr d = a + b + c;
        builder.create_big_add_gate({ builder.add_variable(a),
                                      builder.add_variable(b),
                                      builder.add_variable(c),
                                      builder.add_variable(d),
                                      fr(1),
                                      fr(1),
                                      fr(1),
                                      fr(-1),
                                      fr(0) });
    }
    DefaultIO<InnerBuilder>::add_default(builder); // default (infinity) pairing points, fixed to zero
    return builder;
}

// UltraVerifier_::reduce_to_pairing_check up to the batch opening claim: the claim's commitments and scalars
// (without W) and the Shplonk point z at which W enters with scalar z (kzg.hpp reduce_verify_batch_opening_claim).
struct Opening {
    bb::g1::element rest; // A, the MSM of every term but W
    FF z;
};

Opening opening_before_w(const std::shared_ptr<InnerVK>& vk, const Proof& proof)
{
    using Shplemini = ShpleminiVerifier_<InnerFlavor::Curve, InnerFlavor::HasZK, flavor_has_gemini_masking<InnerFlavor>()>;
    using ClaimBatcher = ClaimBatcher_<InnerFlavor::Curve>;
    using ClaimBatch = ClaimBatcher::Batch;
    auto vk_and_hash = std::make_shared<InnerFlavor::VKAndHash>(vk);
    auto instance = std::make_shared<VerifierInstance_<InnerFlavor>>(vk_and_hash);
    auto transcript = std::make_shared<InnerFlavor::Transcript>();
    transcript->load_proof(proof);
    const size_t log_n = InnerFlavor::VIRTUAL_LOG_N;
    const size_t num_public_inputs = ProofLength::Honk<InnerFlavor>::derive_num_public_inputs(proof.size(), log_n);
    OinkVerifier<InnerFlavor> oink{ instance, transcript, num_public_inputs };
    oink.verify();
    instance->gate_challenges = transcript->template get_dyadic_powers_of_challenge<FF>("Sumcheck:gate_challenge", log_n);
    auto commitments = VerifierCommitmentsConstructor<InnerFlavor>::construct(
        instance->get_vk(), instance->witness_commitments, instance->gemini_masking_commitment);
    SumcheckVerifier<InnerFlavor> sumcheck(transcript, instance->alpha, log_n);
    std::array<Commitment, NUM_SMALL_IPA_COMMITMENTS> libra = {};
    libra[0] = transcript->template receive_from_prover<Commitment>("Libra:concatenation_commitment");
    auto sumcheck_output = sumcheck.verify(instance->relation_parameters, instance->gate_challenges);
    libra[1] = transcript->template receive_from_prover<Commitment>("Libra:grand_sum_commitment");
    libra[2] = transcript->template receive_from_prover<Commitment>("Libra:quotient_commitment");
    EXPECT_TRUE(sumcheck_output.verified);
    ClaimBatcher batcher{
        .unshifted = ClaimBatch{ commitments.get_unshifted(), sumcheck_output.claimed_evaluations.get_unshifted() },
        .shifted = ClaimBatch{ commitments.get_to_be_shifted(), sumcheck_output.claimed_evaluations.get_shifted() }
    };
    auto shplemini = Shplemini::compute_batch_opening_claim(batcher,
                                                            sumcheck_output.challenge,
                                                            Commitment::one(),
                                                            transcript,
                                                            InnerFlavor::REPEATED_COMMITMENTS,
                                                            libra,
                                                            sumcheck_output.claimed_libra_evaluation);
    EXPECT_TRUE(shplemini.consistency_checked);
    auto& claim = shplemini.batch_opening_claim;
    bb::g1::element rest = bb::g1::element::infinity();
    for (size_t i = 0; i < claim.commitments.size(); ++i) {
        rest = rest + bb::g1::element(claim.commitments[i]) * claim.scalars[i];
    }
    return { rest, claim.evaluation_point };
}

// The proof with its KZG:W commitment replaced.
Proof with_w(const Proof& proof, const Commitment& w, size_t num_public_inputs)
{
    StructuredProof<InnerFlavor> structured;
    Proof data = proof;
    structured.deserialize(data, num_public_inputs, InnerFlavor::VIRTUAL_LOG_N);
    structured.kzg_w_comm = w;
    structured.serialize(data, InnerFlavor::VIRTUAL_LOG_N);
    return data;
}

// Native verification of the inner proof; a throw (bb.js surfaces it as a refusal) counts as false.
bool native_inner(const std::shared_ptr<InnerVK>& vk, const Proof& proof, std::string& why)
{
    try {
        InnerVerifier verifier(std::make_shared<InnerFlavor::VKAndHash>(vk));
        return verifier.verify_proof(proof).result;
    } catch (const std::exception& e) {
        why = e.what();
        return false;
    }
}

struct OuterResult {
    std::vector<uint8_t> vk;
    std::vector<uint8_t> proof;
    bool satisfied;
    bool p0_infinity;
    bool p1_infinity;
    bool verified;
    std::vector<FF> pairing_public_inputs;
};

// A circuit that recursively verifies `proof` under `vk` (the Noir HONK_ZK recursion: Ultra-ZK recursive flavor,
// DefaultIO, its points accumulator made public), proved and verified natively as Ultra-ZK.
OuterResult outer(const std::shared_ptr<InnerVK>& vk, const Proof& proof)
{
    OuterBuilder builder;
    auto stdlib_vk_and_hash = std::make_shared<RecursiveFlavor::VKAndHash>(builder, vk);
    RecursiveVerifier verifier{ stdlib_vk_and_hash };
    bb::stdlib::Proof<OuterBuilder> stdlib_proof(builder, proof);
    auto output = verifier.verify_proof(stdlib_proof);
    DefaultIO<OuterBuilder> inputs;
    inputs.pairing_inputs = output.points_accumulator;
    inputs.set_public();
    OuterResult result{};
    result.p0_infinity = output.points_accumulator.P0().get_value().is_point_at_infinity();
    result.p1_infinity = output.points_accumulator.P1().get_value().is_point_at_infinity();
    result.satisfied = !builder.failed() && CircuitChecker::check(builder);
    auto instance = std::make_shared<OuterProverInstance>(builder);
    auto outer_vk = std::make_shared<OuterFlavor::VerificationKey>(instance->get_precomputed());
    OuterProver prover(instance, outer_vk);
    auto outer_proof = prover.construct_proof();
    for (size_t i = 0; i < PAIRING_POINTS_SIZE; ++i) {
        result.pairing_public_inputs.push_back(outer_proof[i]);
    }
    result.vk = to_buffer(*outer_vk);
    for (const auto& word : outer_proof) {
        auto bytes = to_buffer(word);
        result.proof.insert(result.proof.end(), bytes.begin(), bytes.end());
    }
    try {
        OuterVerifier native(std::make_shared<OuterFlavor::VKAndHash>(outer_vk));
        result.verified = native.verify_proof(outer_proof).result;
    } catch (const std::exception& e) {
        info("outer native verification threw: ", e.what());
        result.verified = false;
    }
    return result;
}

void report(const std::string& name, bool inner, const std::string& why, const OuterResult& r)
{
    info("MOE-PROBE ",
         name,
         ": inner_native=",
         inner,
         why.empty() ? "" : " (" + why + ")",
         " outer_satisfied=",
         r.satisfied,
         " accumulator_P0_infinity=",
         r.p0_infinity,
         " accumulator_P1_infinity=",
         r.p1_infinity,
         " outer_native=",
         r.verified);
    std::string limbs;
    for (const auto& f : r.pairing_public_inputs) {
        limbs += (f.is_zero() ? "0" : "x");
    }
    info("MOE-PROBE ", name, ": outer pairing-point public inputs (0 = zero field): ", limbs);
}

} // namespace

class MoeInfinityProbe : public testing::Test {
  public:
    static void SetUpTestSuite() { bb::srs::init_bn254_net_crs_factory(bb::srs::bb_crs_path()); }
};

TEST_F(MoeInfinityProbe, InnerPcsPointAtInfinity)
{
    auto builder = inner_circuit();
    auto instance = std::make_shared<InnerProverInstance>(builder);
    auto vk = std::make_shared<InnerVK>(instance->get_precomputed());
    InnerProver prover(instance, vk);
    Proof proof = prover.construct_proof();
    const size_t num_public_inputs = prover.num_public_inputs();
    StructuredProof<InnerFlavor> structured;
    Proof copy = proof;
    structured.deserialize(copy, num_public_inputs, InnerFlavor::VIRTUAL_LOG_N);
    const Commitment honest_w = structured.kzg_w_comm;

    // Control 1: the honest proof.
    std::string why;
    bool inner = native_inner(vk, proof, why);
    auto honest = outer(vk, proof);
    report("honest", inner, why, honest);
    EXPECT_TRUE(inner);
    EXPECT_TRUE(honest.satisfied);
    EXPECT_TRUE(honest.verified);

    // A and z for this proof: P0 = A + z * W.
    auto [rest, z] = opening_before_w(vk, proof);
    {
        InnerVerifier verifier(std::make_shared<InnerFlavor::VKAndHash>(vk));
        auto reduced = verifier.reduce_to_pairing_check(proof);
        // The replicated reduction agrees with bb's: P0 = A + z * W.
        EXPECT_EQ(Commitment(rest + bb::g1::element(honest_w) * z), reduced.pairing_points.P0());
    }

    // Control 2: W moved by a random multiple of the generator (P0 is not at infinity): the deferred pairing
    // check must catch it at the outer proof's native verification.
    Commitment moved_w = Commitment(bb::g1::element(honest_w) + bb::g1::element(Commitment::one()) * FF::random_element());
    Proof moved = with_w(proof, moved_w, num_public_inputs);
    why.clear();
    inner = native_inner(vk, moved, why);
    auto moved_result = outer(vk, moved);
    report("moved_w", inner, why, moved_result);
    EXPECT_FALSE(inner);
    EXPECT_TRUE(moved_result.satisfied);
    EXPECT_FALSE(moved_result.p0_infinity);
    EXPECT_FALSE(moved_result.verified);

    // The case: W = -A / z, so the inner PCS point P0 = A + z * W is the point at infinity.
    Commitment infinity_w = Commitment(-(rest * z.invert()));
    Proof forged = with_w(proof, infinity_w, num_public_inputs);
    why.clear();
    inner = native_inner(vk, forged, why);
    auto forged_result = outer(vk, forged);
    report("infinity_w", inner, why, forged_result);
    EXPECT_FALSE(inner);
    EXPECT_TRUE(forged_result.satisfied);
    EXPECT_TRUE(forged_result.p0_infinity);
    // The question the probe answers (recorded, not asserted): is forged_result.verified true?
    info("MOE-PROBE verdict: outer proof over the infinity-W inner proof verifies natively: ", forged_result.verified);
    // The forged outer proof and its key in bb.js's bytes (no public input of its own; the proof's first eight
    // words are its pairing-point object), for the reference's real-proof check.
    if (const char* out = std::getenv("MOE_PROBE_FIXTURE"); out != nullptr) {
        auto hex = [](const std::vector<uint8_t>& bytes) {
            static const char* digits = "0123456789abcdef";
            std::string text;
            for (uint8_t b : bytes) {
                text += digits[b >> 4];
                text += digits[b & 15];
            }
            return text;
        };
        std::ofstream(out) << "{\"vk\":\"" << hex(forged_result.vk) << "\",\"proof\":\"" << hex(forged_result.proof)
                           << "\"}\n";
        info("MOE-PROBE fixture: vk ", forged_result.vk.size(), " bytes, proof ", forged_result.proof.size(), " bytes");
    }
}

// Hostile inputs: bb's native assertions only warn (BB_DISABLE_ASSERTS), so bb's own witness generation builds the
// recursive verifier circuit over them; the circuit checker and the builder's first recorded failure name the
// in-circuit constraint each breaks. A malicious prover also picks the helper witnesses (quotients, borrows, hints)
// bb generates here, so this supports, and the source reading of each constraint establishes, that none satisfies it.
TEST_F(MoeInfinityProbe, MaliciousProverWitnesses)
{
    auto builder = inner_circuit();
    auto instance = std::make_shared<InnerProverInstance>(builder);
    auto vk = std::make_shared<InnerVK>(instance->get_precomputed());
    InnerProver prover(instance, vk);
    const Proof proof = prover.construct_proof();
    const size_t at = prover.num_public_inputs(); // the hiding commitment's x.lo, x.hi, y.lo, y.hi
    const uint256_t shift = uint256_t(1) << 136;
    const uint256_t q = bb::fq::modulus;
    auto split = [&](const uint256_t& v) { return std::pair<FF, FF>{ FF(v & (shift - 1)), FF(v >> 136) }; };
    auto join = [&](const Proof& p, size_t i) { return uint256_t(p[i]) + (uint256_t(p[i + 1]) << 136); };

    auto run = [&](const std::string& name, const Proof& hostile, const std::shared_ptr<InnerVK>& key, std::optional<FF> hash) {
        BB_DISABLE_ASSERTS();
        OuterBuilder outer;
        auto stdlib_vk_and_hash = std::make_shared<RecursiveFlavor::VKAndHash>(outer, key);
        if (hash.has_value()) {
            stdlib_vk_and_hash->hash = field_t<OuterBuilder>::from_witness(&outer, *hash);
        }
        RecursiveVerifier verifier{ stdlib_vk_and_hash };
        bb::stdlib::Proof<OuterBuilder> stdlib_proof(outer, hostile);
        auto output = verifier.verify_proof(stdlib_proof);
        DefaultIO<OuterBuilder> inputs;
        inputs.pairing_inputs = output.points_accumulator;
        inputs.set_public();
        const bool satisfied = CircuitChecker::check(outer);
        info("MOE-PROBE malicious ", name, ": satisfied=", satisfied, " first_failure=\"", outer.err(), "\"");
        return satisfied;
    };

    EXPECT_TRUE(run("none (honest witness)", proof, vk, std::nullopt));

    // The same x coordinate with its low limb past 136 bits: lo + 2^136, hi - 1.
    Proof limb = proof;
    ASSERT_FALSE(limb[at + 1].is_zero());
    limb[at] = FF(uint256_t(limb[at]) + shift);
    limb[at + 1] = limb[at + 1] - FF(1);
    EXPECT_FALSE(run("x low limb past 136 bits, same value", limb, vk, std::nullopt));

    // The x coordinate plus the base field's modulus (an alias of the same point), where it stays below 2^254.
    Proof alias = proof;
    const uint256_t x = join(proof, at);
    if (x + q < (uint256_t(1) << 254)) {
        std::tie(alias[at], alias[at + 1]) = split(x + q);
        EXPECT_FALSE(run("x + q (aliased coordinate)", alias, vk, std::nullopt));
    } else {
        info("MOE-PROBE malicious x + q: skipped (x + q reaches 2^254)");
    }

    // y + 1: off the curve.
    Proof curve = proof;
    std::tie(curve[at + 2], curve[at + 3]) = split(join(proof, at + 2) + 1);
    EXPECT_FALSE(run("y + 1 (off the curve)", curve, vk, std::nullopt));

    // (x, y) = (0, y) with y nonzero: not the infinity encoding, and off the curve.
    Proof half = proof;
    half[at] = FF(0);
    half[at + 1] = FF(0);
    EXPECT_FALSE(run("x = 0 with y kept", half, vk, std::nullopt));

    // The genuine proof and key presented with another key hash.
    EXPECT_FALSE(run("key hash + 1", proof, vk, vk->hash() + FF(1)));
}

} // namespace bb::stdlib::recursion::honk
