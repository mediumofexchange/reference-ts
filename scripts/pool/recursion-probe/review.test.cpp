// Reviewer probe (disposable): node-style aggregation of two recursive verifications, as Noir's
// HonkRecursionConstraintsOutput::update does, over forged inner proofs (W = -A/z) and an inner with W at infinity.
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

namespace bb::stdlib::recursion::honk {
namespace {
using RFlavor = UltraZKRecursiveFlavor_<UltraCircuitBuilder>;
using IFlavor = RFlavor::NativeFlavor;
using IBuilder = IFlavor::CircuitBuilder;
using IVK = IFlavor::VerificationKey;
using OFlavor = UltraZKFlavor;
using RVerifier = UltraVerifier_<RFlavor, DefaultIO<UltraCircuitBuilder>>;
using FF = IFlavor::FF;
using Comm = IFlavor::Commitment;
using Prf = std::vector<FF>;

IBuilder inner_circuit()
{
    IBuilder builder;
    for (size_t i = 0; i < 1024; ++i) {
        fr a = fr::random_element(), b = fr::random_element(), c = fr::random_element();
        builder.create_big_add_gate({ builder.add_variable(a), builder.add_variable(b), builder.add_variable(c),
                                      builder.add_variable(a + b + c), fr(1), fr(1), fr(1), fr(-1), fr(0) });
    }
    DefaultIO<IBuilder>::add_default(builder);
    return builder;
}

std::pair<bb::g1::element, FF> opening_before_w(const std::shared_ptr<IVK>& vk, const Prf& proof)
{
    using Shplemini = ShpleminiVerifier_<IFlavor::Curve, IFlavor::HasZK, flavor_has_gemini_masking<IFlavor>()>;
    using CB = ClaimBatcher_<IFlavor::Curve>;
    auto instance = std::make_shared<VerifierInstance_<IFlavor>>(std::make_shared<IFlavor::VKAndHash>(vk));
    auto transcript = std::make_shared<IFlavor::Transcript>();
    transcript->load_proof(proof);
    const size_t log_n = IFlavor::VIRTUAL_LOG_N;
    OinkVerifier<IFlavor> oink{ instance, transcript, ProofLength::Honk<IFlavor>::derive_num_public_inputs(proof.size(), log_n) };
    oink.verify();
    instance->gate_challenges = transcript->template get_dyadic_powers_of_challenge<FF>("Sumcheck:gate_challenge", log_n);
    auto commitments = VerifierCommitmentsConstructor<IFlavor>::construct(instance->get_vk(), instance->witness_commitments, instance->gemini_masking_commitment);
    SumcheckVerifier<IFlavor> sumcheck(transcript, instance->alpha, log_n);
    std::array<Comm, NUM_SMALL_IPA_COMMITMENTS> libra = {};
    libra[0] = transcript->template receive_from_prover<Comm>("Libra:concatenation_commitment");
    auto so = sumcheck.verify(instance->relation_parameters, instance->gate_challenges);
    libra[1] = transcript->template receive_from_prover<Comm>("Libra:grand_sum_commitment");
    libra[2] = transcript->template receive_from_prover<Comm>("Libra:quotient_commitment");
    CB batcher{ .unshifted = typename CB::Batch{ commitments.get_unshifted(), so.claimed_evaluations.get_unshifted() },
                .shifted = typename CB::Batch{ commitments.get_to_be_shifted(), so.claimed_evaluations.get_shifted() } };
    auto sh = Shplemini::compute_batch_opening_claim(batcher, so.challenge, Comm::one(), transcript, IFlavor::REPEATED_COMMITMENTS, libra, so.claimed_libra_evaluation);
    bb::g1::element rest = bb::g1::element::infinity();
    for (size_t i = 0; i < sh.batch_opening_claim.commitments.size(); ++i) {
        rest = rest + bb::g1::element(sh.batch_opening_claim.commitments[i]) * sh.batch_opening_claim.scalars[i];
    }
    return { rest, sh.batch_opening_claim.evaluation_point };
}

Prf with_w(const Prf& proof, const Comm& w, size_t npi)
{
    StructuredProof<IFlavor> s;
    Prf data = proof;
    s.deserialize(data, npi, IFlavor::VIRTUAL_LOG_N);
    s.kzg_w_comm = w;
    s.serialize(data, IFlavor::VIRTUAL_LOG_N);
    return data;
}

struct Inner {
    std::shared_ptr<IVK> vk;
    Prf honest, forged, w_inf;
};

Inner make_inner()
{
    auto builder = inner_circuit();
    auto instance = std::make_shared<ProverInstance_<IFlavor>>(builder);
    Inner in;
    in.vk = std::make_shared<IVK>(instance->get_precomputed());
    UltraProver_<IFlavor> prover(instance, in.vk);
    in.honest = prover.construct_proof();
    const size_t npi = prover.num_public_inputs();
    auto [rest, z] = opening_before_w(in.vk, in.honest);
    in.forged = with_w(in.honest, Comm(-(rest * z.invert())), npi);
    in.w_inf = with_w(in.honest, Comm::one(), npi);
    size_t changed = 0;
    for (size_t i = 0; i < in.honest.size(); ++i) {
        if (in.w_inf[i] != in.honest[i]) { in.w_inf[i] = FF(0); ++changed; }
    }
    info("MOE-REVIEW w_inf zeroed words: ", changed, " last index honest==? ", in.w_inf.size());
    return in;
}

void outer(const std::string& name, const std::vector<std::pair<std::shared_ptr<IVK>, Prf>>& children)
{
    UltraCircuitBuilder builder;
    PairingPoints<bn254<UltraCircuitBuilder>> acc;
    for (const auto& [vk, proof] : children) {
        RVerifier verifier{ std::make_shared<RFlavor::VKAndHash>(builder, vk) };
        bb::stdlib::Proof<UltraCircuitBuilder> sp(builder, proof);
        auto out = verifier.verify_proof(sp);
        if (acc.is_populated()) { acc.aggregate(out.points_accumulator); } else { acc = out.points_accumulator; }
    }
    DefaultIO<UltraCircuitBuilder> io;
    io.pairing_inputs = acc;
    io.set_public();
    const bool satisfied = !builder.failed() && CircuitChecker::check(builder);
    auto instance = std::make_shared<ProverInstance_<OFlavor>>(builder);
    auto ovk = std::make_shared<OFlavor::VerificationKey>(instance->get_precomputed());
    UltraProver_<OFlavor> prover(instance, ovk);
    auto op = prover.construct_proof();
    std::string limbs;
    for (size_t i = 0; i < PAIRING_POINTS_SIZE; ++i) limbs += op[i].is_zero() ? "0" : "x";
    bool zero0 = limbs.substr(0, 4) == "0000", zero1 = limbs.substr(4, 4) == "0000";
    bool verified = false;
    try {
        UltraVerifier_<OFlavor, bb::DefaultIO> nv(std::make_shared<OFlavor::VKAndHash>(ovk));
        verified = nv.verify_proof(op).result;
    } catch (const std::exception& e) { info("threw: ", e.what()); }
    info("MOE-REVIEW ", name, ": satisfied=", satisfied, " object=", limbs, " native=", verified,
         " mixed(refused by fix)=", zero0 != zero1, " accepted_after_fix=", verified && !(zero0 != zero1));
}
} // namespace

class MoeReviewProbe : public testing::Test {
  public:
    static void SetUpTestSuite() { bb::srs::init_bn254_net_crs_factory(bb::srs::bb_crs_path()); }
};

TEST_F(MoeReviewProbe, NodeAggregation)
{
    auto a = make_inner();
    auto b = make_inner();
    outer("node honest+honest", { { a.vk, a.honest }, { b.vk, b.honest } });
    outer("node forged+honest", { { a.vk, a.forged }, { b.vk, b.honest } });
    outer("node honest+forged", { { a.vk, a.honest }, { b.vk, b.forged } });
    outer("node forged+forged", { { a.vk, a.forged }, { b.vk, b.forged } });
    {
        BB_DISABLE_ASSERTS();
        outer("leaf w_inf (P1 at infinity, asserts warn)", { { a.vk, a.w_inf } });
    }
}
} // namespace bb::stdlib::recursion::honk
