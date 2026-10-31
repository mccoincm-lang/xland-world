/* Xland Forge: the transactions that create Xland's five tokens on Base (r57).
   Shared by the founder's Forge page (src/forge.html; tools/build.mjs inlines this file) and its tests
   (test/forge-calls.cjs builds the same calldata and runs it against Base's own B20 mocks in Foundry).
   Nothing here holds a key: the page only builds calldata and asks the founder's wallet to sign and send it.
   Supplies start at zero. Nothing is minted here; the founder can grant MINT_ROLE later (to the Xland Port). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.XlandForge = factory;
})(typeof self !== 'undefined' ? self : this, function (ethers) {
  const { AbiCoder, Interface, keccak256, toUtf8Bytes, id } = ethers;
  const abi = AbiCoder.defaultAbiCoder();
  const ADDR = {
    factory: '0xB20f000000000000000000000000000000000000',
    policy: '0x8453000000000000000000000000000000000002',
    activation: '0x8453000000000000000000000000000000000001'
  };
  const FEATURE = { asset: id('base.b20_asset'), policy: id('base.policy_registry') };
  const ROLE = { admin: '0x' + '00'.repeat(32), mint: id('MINT_ROLE'), burn: id('BURN_ROLE'), pause: id('PAUSE_ROLE'), unpause: id('UNPAUSE_ROLE') };
  const SCOPE = { sender: id('TRANSFER_SENDER_POLICY'), receiver: id('TRANSFER_RECEIVER_POLICY'), executor: id('TRANSFER_EXECUTOR_POLICY'), mintTo: id('MINT_RECEIVER_POLICY') };
  const ALWAYS_BLOCK = (1n << 56n) | 1n;          // PolicyRegistry sentinel: nobody is authorized
  const ALLOWLIST = 1, ASSET = 0, TRANSFER = 0;   // PolicyType.ALLOWLIST, B20Variant.ASSET, PausableFeature.TRANSFER
  const iFactory = new Interface([
    'function createB20(uint8 variant, bytes32 salt, bytes params, bytes[] initCalls) returns (address)',
    'function getB20Address(uint8 variant, address sender, bytes32 salt) view returns (address)',
    'function isB20Initialized(address token) view returns (bool)',
    'event B20Created(address indexed token, uint8 indexed variant, string name, string symbol, uint8 decimals, bytes variantEventParams)'
  ]);
  const iPolicy = new Interface([
    'function createPolicy(address admin, uint8 policyType) returns (uint64)',
    'function policyExists(uint64 policyId) view returns (bool)',
    'function policyAdmin(uint64 policyId) view returns (address)',
    'event PolicyCreated(uint64 indexed policyId, address indexed creator, uint8 policyType)'
  ]);
  const iActivation = new Interface(['function isActivated(bytes32 feature) view returns (bool)']);
  const iToken = new Interface([
    'function updateSupplyCap(uint256 newSupplyCap)',
    'function updatePolicy(bytes32 policyScope, uint64 newPolicyId)',
    'function pause(uint8[] features)',
    'function grantRole(bytes32 role, address account)',
    'function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
    'function totalSupply() view returns (uint256)', 'function supplyCap() view returns (uint256)',
    'function hasRole(bytes32 role, address account) view returns (bool)'
  ]);
  const assetParams = (name, symbol, admin, decimals) => abi.encode(['tuple(uint8,string,string,address,uint8)'], [[1, name, symbol, admin, decimals]]);

  /* The three B20 tokens. Salts are fixed so each token's address is known before it exists, and re-running a step
     can never create a second token. */
  function tokens(admin, citizensPolicy) {
    return [
      { key: 'quarx', name: 'QuarX', symbol: 'QUARX', decimals: 18, salt: id('xland.quarx.v1'),
        about: 'Capped at 1,000,000,000. Supply starts at zero: genesis and mining are minted later, only by roles you grant.',
        init: [iToken.encodeFunctionData('updateSupplyCap', [10n ** 9n * 10n ** 18n])] },
      { key: 'bux', name: 'BuX', symbol: 'BUX', decimals: 6, salt: id('xland.bux.v1'),
        about: 'Only wallets on the citizens list can hold, send or receive it, and transfers start paused until the legal opinion (A4).',
        needs: 'policy',
        init: citizensPolicy == null ? null : [
          iToken.encodeFunctionData('updatePolicy', [SCOPE.sender, citizensPolicy]),
          iToken.encodeFunctionData('updatePolicy', [SCOPE.receiver, citizensPolicy]),
          iToken.encodeFunctionData('updatePolicy', [SCOPE.executor, citizensPolicy]),
          iToken.encodeFunctionData('updatePolicy', [SCOPE.mintTo, citizensPolicy]),
          iToken.encodeFunctionData('pause', [[TRANSFER]])
        ] },
      { key: 'lex', name: 'Lex', symbol: 'LEX', decimals: 6, salt: id('xland.lex.v1'),
        about: 'Nobody can send it to anyone: it is earned, never sold.',
        init: [iToken.encodeFunctionData('updatePolicy', [SCOPE.sender, ALWAYS_BLOCK])] }
    ].map(t => Object.assign(t, {
      createData: t.init && iFactory.encodeFunctionData('createB20', [ASSET, t.salt, assetParams(t.name, t.symbol, admin, t.decimals), t.init])
    }));
  }
  const createPolicyData = admin => iPolicy.encodeFunctionData('createPolicy', [admin, ALLOWLIST]);
  const deployData = (bytecode, admin, uri) => bytecode + abi.encode(['address', 'string'], [admin, uri]).slice(2);
  const URIS = { deeds: 'https://xland.world/api/deed/', passport: 'https://xland.world/api/passport/' };
  return { ADDR, FEATURE, ROLE, SCOPE, ALWAYS_BLOCK, iFactory, iPolicy, iActivation, iToken, tokens, createPolicyData, deployData, assetParams, URIS };
});
