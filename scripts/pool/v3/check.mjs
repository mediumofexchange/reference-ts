// Combined successor relation evidence. No production admission/configuration.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Noir } from '@noir-lang/noir_js';
import { Barretenberg, BackendType, UltraHonkBackend, UltraHonkVerifierBackend } from '@aztec/bb.js';
import { fixtures, field, U64_MAX } from '../fixtures.mjs';
import { deliveryHash, requireDeliveryVector } from '../delivery/crypto.mjs';

const here = import.meta.dirname, root = resolve(here, '../../..');
mkdirSync(join(root, 'scratch'), { recursive: true });
const scratch = realpathSync(join(root, 'scratch'));
const build = realpathSync(mkdtempSync(join(scratch, 'pool-v3-conformance-')));
const reportPath = join(scratch, 'pool-v3-results.json');
const json = p => JSON.parse(readFileSync(p, 'utf8'));
const sha = b => createHash('sha256').update(b).digest('hex');
const kinds = ['issue','spend','burn','demand','settle','request'];
const counts = { issue: 11, spend: 15, burn: 15, demand: 16, settle: 17, request: 7 };
const options = Object.freeze({ verifierTarget: 'noir-recursive' });
const manifest = json(join(root, 'src/pool/circuits/manifest.json'));
for (const [name, version] of Object.entries(manifest.toolchain)) assert.equal(json(join(root, 'node_modules', name, 'package.json')).version, version);
const checks = [], metrics = [], identities = {}, circuits = {}, proofs = {};
let api;
try {
  execFileSync(process.execPath, [join(here, 'compile.mjs'), build], { cwd: root, windowsHide: true, stdio: 'inherit', timeout: 300000 });
  const compiledSourceHashes = json(join(build, 'source-hashes.json'));
  assert.equal(compiledSourceHashes.poseidon2, manifest.sources['vendor/poseidon2.nr']);
  api = await Barretenberg.new({ backend: BackendType.WasmWorker, threads: 1, crsPath: join(root, 'scratch/private-payment-crs') });
  for (const kind of kinds) {
    const program = json(join(build, kind + '.json'));
    assert.equal(program.noir_version, '1.0.0-beta.26+40d6574f851d926f93e0c3a271bac3e6e82ac905');
    const backend = new UltraHonkBackend(program.bytecode, api), vk = await backend.getVerificationKey(options);
    circuits[kind] = { program, backend, vk, noir: new Noir(program) };
    identities[kind] = { source: sha(readFileSync(join(here, 'circuits', kind + '.nr'))), bytecode: sha(Buffer.from(program.bytecode, 'base64')), vk: sha(vk), vkBytes: vk.length };
    assert.equal(identities[kind].source, compiledSourceHashes[kind], kind + ': source changed during build');
  }
  assert.equal(new Set(kinds.map(k => identities[k].vk)).size, 6);
  const f = await fixtures(api), verifier = new UltraHonkVerifierBackend(api);
  const tag = nf => f.hash([1007, nf]);
  const prefix = v => [...v.domain, ...v.segment, v.scope];
  const publicInputsOf = (kind, v) => ({
    issue: () => [...prefix(v), ...v.backing, v.quantity, v.cm, ...v.delivery],
    spend: () => [...prefix(v), ...v.anchors, ...v.nullifiers, ...v.outputs, ...v.delivery],
    burn: () => [...prefix(v), ...v.backing, v.quantity, ...v.anchors, ...v.nullifiers, v.cm_change, ...v.delivery],
    demand: () => [...prefix(v), ...v.backing, v.quantity, ...v.anchors, ...v.tags, ...v.presenter, v.instant, v.deadline],
    settle: () => [...prefix(v), ...v.backing, v.quantity, v.owner, v.rho_out, ...v.anchors, ...v.nullifiers, v.cm_out, ...v.demand],
    request: () => [...v.domain, ...v.backing, v.anchor, v.tag, v.refresh],
  })[kind]().map(field);
  const bytes32 = values => Buffer.concat(values.map(v => Buffer.from(BigInt(v).toString(16).padStart(32, '0'), 'hex')));
  const delivery = (kind, v) => {
    const commitments = kind === 'issue' ? [v.cm] : kind === 'spend' ? v.outputs : [v.cm_change];
    // Opaque public capsules are sufficient for the relation/host-hash boundary;
    // receiver decryption is deliberately not claimed by this fixture.
    const vector = commitments.map((cm, i) => ({ cm: BigInt(cm), capsule: Uint8Array.from({ length: 89 }, (_, j) => j === 0 ? 1 : (i + j) & 255) }));
    const digest = deliveryHash(bytes32(v.domain), vector);
    v.delivery = [digest.subarray(0, 16), digest.subarray(16)].map(b => BigInt('0x' + Buffer.from(b).toString('hex')).toString());
    return { vector, digest };
  };
  async function rebuild(kind, v) {
    if (v.inputs) {
      const leaves = await Promise.all(v.inputs.flatMap((n, i) => BigInt(n.value) > 0n ? [f.cm(n, v.domain).then(cm => [BigInt(i), cm])] : []));
      const tree = await f.tree(leaves);
      v.anchors = v.inputs.map(n => kind === 'demand' && BigInt(n.value) === 0n ? field(0) : tree.root);
      v.siblings = v.inputs.map((_, i) => tree.path(BigInt(i)).siblings);
      v.right = v.inputs.map((_, i) => tree.path(BigInt(i)).right);
      const nfs = await Promise.all(v.inputs.map((n,i) => f.nf(n, v.secrets[i], v.domain)));
      if (kind === 'demand') v.tags = await Promise.all(nfs.map((nf,i) => BigInt(v.inputs[i].value) > 0n ? tag(nf) : field(0)));
      else v.nullifiers = nfs;
    }
    if (kind === 'request') {
      const tree = await f.tree([[0n, await f.cm(v.note, v.domain)]]);
      v.anchor = tree.root; v.siblings = tree.path(0n).siblings; v.right = tree.path(0n).right;
      v.tag = await tag(await f.nf(v.note, v.secret, v.domain));
    }
    if (kind === 'issue') v.cm = await f.cm({ backing: v.backing, value: v.quantity, owner: v.owner, rho: v.rho }, v.domain);
    if (kind === 'spend') v.outputs = await Promise.all(v.output_notes.map(n => f.cm(n, v.domain)));
    if (kind === 'burn') v.cm_change = await f.cm(v.change, v.domain);
    if (kind === 'settle') v.cm_out = await f.cm({ backing: v.backing, value: v.quantity, owner: v.owner, rho: v.rho_out }, v.domain);
    // The ABI-bypass range tests deliberately use an unencodable domain.
    // Delivery limbs are independent public metadata in that circuit test.
    if (['issue','spend','burn'].includes(kind) && v.domain.every(x=>BigInt(x)<(1n<<128n))) delivery(kind,v);
    return v;
  }
  const spend = structuredClone(f.padded);
  spend.output_notes.push((await f.note(f.a, 0n)).opening, (await f.note(f.a, 0n)).opening);
  await rebuild('spend', spend);
  const path = f.scope.path(0n), p = f.padded;
  const demand = { domain: [...f.domain], segment: [...f.segment], scope: f.scope.root, backing: [...f.a], quantity: '100',
    anchors: [p.anchors[0], field(0)], tags: [await tag(p.nullifiers[0]), field(0)], presenter: ['11','13'], instant: '10', deadline: '20',
    inputs: structuredClone(p.inputs), secrets: [...p.secrets], siblings: structuredClone(p.siblings), right: structuredClone(p.right),
    link: [...f.linkA], scope_siblings: path.siblings, scope_right: path.right };
  const backer = (await f.note(f.a, 100n)).opening;
  const settle = { domain: [...f.domain], segment: [...f.segment], scope: f.scope.root, backing: [...f.a], quantity: '100', owner: backer.owner, rho_out: backer.rho,
    anchors: [...p.anchors], nullifiers: [...p.nullifiers], cm_out: await f.cm(backer), demand: ['5','6'],
    inputs: structuredClone(p.inputs), secrets: [...p.secrets], siblings: structuredClone(p.siblings), right: structuredClone(p.right),
    link: [...f.linkA], scope_siblings: path.siblings, scope_right: path.right };
  const request = { domain: [...f.domain], backing: [...f.a], anchor: p.anchors[0], tag: await tag(p.nullifiers[0]), refresh: '0',
    note: structuredClone(p.inputs[0]), secret: p.secrets[0], siblings: structuredClone(p.siblings[0]), right: structuredClone(p.right[0]) };
  const bases = { issue: structuredClone(f.issue), spend, burn: structuredClone(f.burn), demand, settle, request };
  for (const kind of ['issue','burn']) delivery(kind, bases[kind]);

  async function accepts(kind, v, label, prove = false, noir = circuits[kind].noir) {
    const start = performance.now(), { witness } = await noir.execute(v);
    if (prove) {
      const executed = performance.now(), proof = await circuits[kind].backend.generateProof(witness, options), proved = performance.now();
      assert.equal(await verifier.verifyProof({ ...proof, verificationKey: circuits[kind].vk }, options), true, label);
      assert.deepEqual(proof.publicInputs.map(field), publicInputsOf(kind, v));
      assert.equal(proof.publicInputs.length, counts[kind]);
      assert(proof.proof.length > 0 && proof.proof.length <= 131072 && proof.proof.length % 32 === 0);
      metrics.push({ kind, label, executeMs: executed-start, proveMs: proved-executed, verifyMs: performance.now()-proved, proofBytes: proof.proof.length, publicInputs: proof.publicInputs.length });
      checks.push(label); return proof;
    }
    checks.push(label);
  }
  async function rejects(kind, label, mutate, base = bases[kind], recompute = false, noir = circuits[kind].noir) {
    const v = structuredClone(base); await mutate(v); if (recompute) await rebuild(kind,v);
    await assert.rejects(noir.execute(v), undefined, label); checks.push(label);
  }
  for (const kind of kinds) proofs[kind] = await accepts(kind, bases[kind], kind + ': exact public order and real proof', true);

  // Distinct anchors/tags disambiguate positions which are both zero in padding.
  const secondReal = await f.note(f.a, 80n);
  const paired = await f.spend(f.first, secondReal, await f.note(f.a, 110n), await f.note(f.a, 70n), [0n,0n], true);
  const demandTwo = structuredClone(demand), settleTwo = structuredClone(settle);
  for (const v of [demandTwo, settleTwo]) {
    v.quantity = '180';
    for (const name of ['inputs','secrets','siblings','right','anchors']) v[name] = structuredClone(paired[name]);
    assert.notEqual(v.anchors[0], v.anchors[1]);
  }
  demandTwo.tags = await Promise.all(paired.nullifiers.map(tag));
  settleTwo.nullifiers = [...paired.nullifiers];
  settleTwo.cm_out = await f.cm({ backing: settleTwo.backing, value: '180', owner: settleTwo.owner, rho: settleTwo.rho_out });
  await accepts('demand', demandTwo, 'demand: two real notes with distinct anchors and tags', true);
  await accepts('settle', settleTwo, 'settle: two real notes with distinct anchors and nullifiers', true);
  const spendTwo = structuredClone(spend), burnTwo = structuredClone(bases.burn);
  for (const v of [spendTwo, burnTwo]) {
    for (const name of ['inputs','secrets','siblings','right','anchors','nullifiers']) v[name] = structuredClone(paired[name]);
    assert.notEqual(v.anchors[0], v.anchors[1]);
  }
  spendTwo.output_notes[0].value = '110'; spendTwo.output_notes[1].value = '70';
  spendTwo.outputs = await Promise.all(spendTwo.output_notes.map(n => f.cm(n)));
  burnTwo.quantity = '150';
  delivery('spend', spendTwo); delivery('burn', burnTwo);
  await accepts('spend', spendTwo, 'spend: two real inputs with distinct anchors', true);
  await accepts('burn', burnTwo, 'burn: two real inputs with distinct anchors', true);

  // Every scalar of every amended key, including F4 prefix and F3 issue/burn.
  for (const kind of kinds) {
    for (let i = 0; i < counts[kind]; i++) {
      const publicInputs = [...proofs[kind].publicInputs]; publicInputs[i] = field(BigInt(publicInputs[i]) + 1n);
      assert.equal(await verifier.verifyProof({ ...proofs[kind], publicInputs, verificationKey: circuits[kind].vk }, options), false, kind + ' binds ' + i);
      checks.push(kind + ': binds public input ' + i);
    }
    const corrupt = new Uint8Array(proofs[kind].proof); corrupt[100] ^= 1;
    assert.equal(await verifier.verifyProof({ ...proofs[kind], proof: corrupt, verificationKey: circuits[kind].vk }, options), false);
    checks.push(kind + ': corrupt proof rejected');
  }
  for (const [from,to] of [['spend','burn'],['burn','spend']]) {
    assert.equal(counts[from], counts[to]);
    for (const publicInputs of [proofs[from].publicInputs, proofs[to].publicInputs]) {
      assert.equal(await verifier.verifyProof({ ...proofs[from], publicInputs, verificationKey: circuits[to].vk }, options), false, from + ' under ' + to);
    }
    checks.push(from + ': rejected under ' + to + ' key with both original and independently valid target inputs');
  }

  // Range constraints below the ABI encoder for metadata not otherwise read.
  for (const kind of kinds) {
    const fields = kind === 'request' ? [['refresh',64]] : [['segment',128]];
    if (['issue','spend','burn'].includes(kind)) fields.push(['delivery',128]);
    if (kind === 'demand') fields.push(['presenter',128],['instant',64],['deadline',64]);
    if (kind === 'settle') fields.push(['demand',128]);
    for (const [name,bits] of fields) {
      const program = structuredClone(circuits[kind].program), parameter = program.abi.parameters.find(p => p.name === name);
      const array = parameter.type.kind === 'array';
      if (array) parameter.type.type = { kind: 'field' }; else parameter.type = { kind: 'field' };
      assert.equal(program.bytecode, circuits[kind].program.bytecode);
      const noir = new Noir(program);
      await accepts(kind, bases[kind], kind + ': unchanged ACIR valid control ' + name, false, noir);
      for (const index of array ? [0,1] : [null]) {
        const maximum = structuredClone(bases[kind]);
        if (array) maximum[name][index] = field((1n << BigInt(bits)) - 1n); else maximum[name] = field((1n << BigInt(bits)) - 1n);
        await accepts(kind, maximum, kind + ': maximum ' + name + index, false, noir);
        await rejects(kind, kind + ': ACIR overflow ' + name + index, v => {
          if (array) v[name][index] = field(1n << BigInt(bits)); else v[name] = field(1n << BigInt(bits));
        }, bases[kind], false, noir);
      }
    }
  }
  for (const kind of ['issue','spend','burn','demand','request']) {
    const other = structuredClone(bases[kind]);
    if (kind === 'demand') { other.presenter = ['21','23']; other.instant = '11'; other.deadline = '25'; }
    else if (kind === 'request') other.refresh = '1';
    else other.delivery = ['0','1'];
    await accepts(kind, other, kind + ': alternative metadata independently proves', true);
    assert.equal(await verifier.verifyProof({ ...proofs[kind], publicInputs: publicInputsOf(kind,other), verificationKey: circuits[kind].vk }, options), false);
    checks.push(kind + ': original proof cannot bind alternative metadata');
  }

  // Scope, ownership, membership and conservation with recomputed witnesses.
  for (const kind of ['issue','spend','burn','demand','settle']) {
    await rejects(kind, kind + ': wrong scope root', v => { v.scope = field(1); });
    await rejects(kind, kind + ': wrong scope link', v => { if (v.links) v.links[0] = [...f.linkB]; else v.link = [...f.linkB]; });
  }
  for (const kind of ['spend','burn','demand','settle']) {
    for (const i of [0,1]) {
      if (kind !== 'demand') await rejects(kind, kind + ': wrong public nullifier ' + i, v => { v.nullifiers[i] = field(1); });
      await rejects(kind, kind + ': unauthorized input ' + i, v => { v.secrets[i] = field(999); }, bases[kind], true);
      await rejects(kind, kind + ': zero secret ' + i, async v => { v.secrets[i] = field(0); v.inputs[i].owner = await f.hash([1001,0]); }, bases[kind], true);
    }
    await rejects(kind, kind + ': wrong real anchor', v => { v.anchors[0] = field(1); });
    await rejects(kind, kind + ': wrong path bit 31', v => { v.right[0][31] = !v.right[0][31]; });
    await rejects(kind, kind + ': foreign padding backing', v => {
      v.inputs[1].backing = [...f.b];
      if (kind === 'spend') { v.links[1] = [...f.linkB]; v.scope_siblings[1] = f.scope.path(1n).siblings; v.scope_right[1] = f.scope.path(1n).right; }
    }, bases[kind], true);
    await rejects(kind, kind + ': duplicate input with conserved quantity', v => {
      v.inputs[1] = structuredClone(v.inputs[0]); v.secrets[1] = v.secrets[0];
      if (kind === 'spend') { v.output_notes[0].value = '140'; }
      else if (kind === 'burn') v.quantity = '170'; else v.quantity = '200';
    }, bases[kind], true);
  }
  for (const kind of ['issue','burn','demand','settle']) {
    await rejects(kind, kind + ': zero quantity', v => {
      v.quantity = '0';
      if (kind === 'burn') v.change.value = '100';
      if (kind === 'demand' || kind === 'settle') v.inputs.forEach(n => { n.value = '0'; });
    }, bases[kind], true);
    if (kind !== 'issue') await rejects(kind, kind + ': wrong conserved quantity', v => { v.quantity = '99'; }, bases[kind], true);
  }
  for (const kind of ['issue','burn','settle']) {
    for (const name of ['owner','rho']) await rejects(kind, kind + ': zero output ' + name, v => {
      if (kind === 'burn') v.change[name] = field(0); else v[name === 'rho' && kind === 'settle' ? 'rho_out' : name] = field(0);
    }, bases[kind], true);
  }
  for (let i=0;i<4;i++) {
    for (const name of ['owner','rho']) await rejects('spend', 'spend: zero output '+name+' '+i, v => { v.output_notes[i][name] = field(0); }, spend, true);
    await rejects('spend', 'spend: wrong output commitment '+i, v => { v.outputs[i] = field(1); });
    // A foreign zero output violates only membership in the input backing set.
    await rejects('spend', 'spend: foreign zero output '+i, v => {
      const value = BigInt(v.output_notes[i].value); v.output_notes[i].value = '0'; v.output_notes[i].backing = [...f.foreign];
      const j = (i+1)%4; v.output_notes[j].value = (BigInt(v.output_notes[j].value)+value).toString();
    }, spend, true);
    for (let j=i+1;j<4;j++) await rejects('spend', 'spend: duplicate output pair '+i+','+j, v => {
      v.output_notes.forEach(n => { n.value = '25'; }); v.output_notes[j] = structuredClone(v.output_notes[i]);
    }, spend, true);
  }
  await rejects('spend','spend: inflated output with recomputed commitments',v=>{v.output_notes[3].value='1';},spend,true);
  await rejects('spend','spend: shaved output with recomputed commitments',v=>{v.output_notes[0].value='39';},spend,true);
  await rejects('spend', 'spend: all-zero inputs and outputs with conserved value', v => {
    v.inputs.forEach(n => { n.value = '0'; });
    v.output_notes.forEach(n => { n.value = '0'; });
  }, spend, true);
  for (const i of [0,1]) await rejects('demand', 'demand: wrong positive-position tag ' + i, v => { v.tags[i] = field(1); }, demandTwo);
  for (const kind of ['burn','demand','settle']) await rejects(kind, kind + ': foreign real input under public backing', v => {
    v.inputs[0].backing = [...f.b];
  }, bases[kind], true);
  for (const i of [0,1]) {
    const v=structuredClone(demand);
    if(i===0) for(const key of ['inputs','secrets','anchors','tags','siblings','right']) v[key].reverse();
    await accepts('demand',v,'demand: canonical padding slot '+i);
    await rejects('demand','demand: nonzero padding anchor '+i,x=>{x.anchors[i]=p.anchors[0];},v);
    await rejects('demand','demand: nonzero padding tag '+i,x=>{x.tags[i]=field(1);},v);
  }
  await rejects('request','request: zero value with recomputed membership',v=>{v.note.value='0';},request,true);
  await rejects('request','request: unauthorized note',v=>{v.secret=field(999);},request,true);
  await rejects('request','request: wrong backing',v=>{v.backing=[...f.b];});
  await rejects('request','request: wrong tag',v=>{v.tag=field(1);});
  await rejects('request','request: wrong anchor',v=>{v.anchor=field(1);});

  // Bypass all integer ABI encodings while retaining byte-for-byte ACIR.
  // Recompute dependent hashes/paths/sums, so ABI/range failures cannot hide
  // behind an unrelated commitment or conservation failure.
  function fieldAbi(program) {
    const copy=structuredClone(program);
    function visit(type) {
      if(type.kind==='integer') return {kind:'field'};
      if(type.kind==='array') type.type=visit(type.type);
      if(type.kind==='struct') for(const member of type.fields) member.type=visit(member.type);
      return type;
    }
    for(const parameter of copy.abi.parameters) parameter.type=visit(parameter.type);
    assert.equal(copy.bytecode,program.bytecode); return new Noir(copy);
  }
  for(const kind of kinds) {
    const noir=fieldAbi(circuits[kind].program);
    await accepts(kind,bases[kind],kind+': all-Field ABI valid control',false,noir);
    for(const i of [0,1]) await rejects(kind,kind+': domain limb overflow with recomputed relation '+i,v=>{v.domain[i]=(1n<<128n).toString();},bases[kind],true,noir);
    if(['issue','burn','demand','settle'].includes(kind)) await rejects(kind,kind+': quantity overflow with exact widened sum',v=>{
      v.quantity=(1n<<64n).toString();
      if(v.inputs) {v.inputs[0].value=(1n<<63n).toString();v.inputs[1].value=(1n<<63n).toString();}
      if(v.change) v.change.value='0';
    },bases[kind],true,noir);
    if(kind==='spend') {
      await rejects(kind,'spend: input u64 overflow with conserved outputs',v=>{
        v.inputs[0].value=(1n<<64n).toString();v.output_notes[0].value=(1n<<63n).toString();v.output_notes[1].value=(1n<<63n).toString();
      },spend,true,noir);
      await rejects(kind,'spend: output u64 overflow with two valid inputs',v=>{
        v.inputs[0].value=(1n<<63n).toString();v.inputs[1].value=(1n<<63n).toString();
        v.output_notes[0].value=(1n<<64n).toString();v.output_notes[1].value='0';
      },spend,true,noir);
    }
  }

  // Positive widened and two-backing controls are proved, not just executed.
  const cross=structuredClone(spend), crossInput=await f.note(f.b,10n);
  cross.inputs[1]=crossInput.opening; cross.secrets[1]=crossInput.secret;
  cross.links[1]=[...f.linkB]; cross.scope_siblings[1]=f.scope.path(1n).siblings; cross.scope_right[1]=f.scope.path(1n).right;
  cross.output_notes=await Promise.all([[f.a,73n],[f.a,27n],[f.b,2n],[f.b,8n]].map(async([b,n])=>(await f.note(b,n)).opening));
  await rebuild('spend',cross); await accepts('spend',cross,'spend: two backings with ordinary fee and both changes',true);
  await rejects('spend', 'spend: second input wrong scope link', v => { v.links[1] = [...f.linkA]; }, cross);
  await rejects('spend', 'spend: second input wrong scope path', v => { v.scope_siblings[1][0] = field(1); }, cross);
  await rejects('spend','spend: backing conversion preserves global total',v=>{v.output_notes[1].value='26';v.output_notes[3].value='9';},cross,true);
  const maxima=structuredClone(spend);
  for(let i=0;i<2;i++){const n=await f.note(f.a,U64_MAX);maxima.inputs[i]=n.opening;maxima.secrets[i]=n.secret;}
  maxima.output_notes[0].value=U64_MAX.toString();maxima.output_notes[1].value=U64_MAX.toString();
  await rebuild('spend',maxima); await accepts('spend',maxima,'spend: two maximum u64 inputs conserve in u128',true);
  await rejects('spend','spend: wrapped u64 conservation',v=>{v.output_notes[0].value=(U64_MAX-1n).toString();v.output_notes[1].value='0';},maxima,true);
  const full=structuredClone(bases.burn);full.quantity='100';full.change.value='0';await rebuild('burn',full);
  await accepts('burn',full,'burn: full value with ordinary zero change',true);
  for(const kind of ['issue','spend','burn']) {
    const v=structuredClone(bases[kind]), {vector,digest}=delivery(kind,v), domain=bytes32(v.domain);
    assert.equal(vector.length,{issue:1,spend:4,burn:1}[kind]);
    assert.deepEqual(requireDeliveryVector(domain,vector,digest),digest);
    assert.throws(()=>requireDeliveryVector(domain,vector.slice(0,-1),digest));
    const bad=structuredClone(vector);bad[0].capsule[1]^=1;
    assert.throws(()=>requireDeliveryVector(domain,bad,digest));
    checks.push(kind+': exact synthetic capsule vector hash, missing/tampered vector rejected');
  }
  const report={candidate:'combined six successor relations', referenceBase:'5ba6099', companionSpec:'d57ddb05237d2a4cbbc18536e6758a0aa63b1bf8',
    environment:{node:process.version,platform:process.platform,arch:process.arch,toolchain:manifest.toolchain,verifierTarget:options.verifierTarget,threads:1},
    counts,identities,sharedSources:Object.fromEntries(['notes.nr','poseidon2.nr'].map(n=>[n,sha(readFileSync(n === 'poseidon2.nr' ? join(root,'src/pool/circuits/vendor/poseidon2.nr') : join(here,'circuits',n)))])),
    publicInputs:Object.fromEntries(kinds.map(k=>[k,publicInputsOf(k,bases[k])])), checks,metrics,
    limits:['Synthetic domain, no final configuration hash','Opaque capsules; no receiver decryption claim','No v3 parser, kind router, admission, authorization, replay, finality or venue completeness','Single desktop run, not device budgets']};
  for (const kind of kinds) assert.equal(sha(readFileSync(join(here, 'circuits', kind + '.nr'))), compiledSourceHashes[kind], kind + ': source changed during proving');
  for (const name of ['notes','poseidon2']) assert.equal(report.sharedSources[name + '.nr'], compiledSourceHashes[name], name + ': helper changed during proving');
  writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log('PASS: '+checks.length+' checks; '+metrics.length+' real proofs; '+reportPath);
} finally {
  if (api) await api.destroy();
  const target = realpathSync(build);
  if (!target.startsWith(scratch + sep)) throw new Error('unsafe v3 build cleanup');
  rmSync(target, { recursive: true, force: true });
}
