// Prints the Forge page's calldata, ABI-encoded for Foundry's vm.ffi: (bytes createPolicy, bytes[] createB20 x3).
// Usage: node test/forge-calls.cjs <admin address> <citizens policy id>
const ethers = require("../tools/vendor/ethers-6.13.4.umd.min.cjs");
const F = require("../src/forge-core.cjs")(ethers);
const [admin, pid] = process.argv.slice(2);
const toks = F.tokens(admin, BigInt(pid));
process.stdout.write(ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "bytes[]"], [F.createPolicyData(admin), toks.map(t => t.createData)]));
