// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {BaseTest} from "base-std-test/lib/BaseTest.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {IPolicyRegistry} from "base-std/interfaces/IPolicyRegistry.sol";
import {StdPrecompiles} from "base-std/StdPrecompiles.sol";
import {B20Constants} from "base-std/lib/B20Constants.sol";

/// Runs the Forge page's own calldata (built by src/forge-core.cjs through test/forge-calls.cjs) against Base's B20 mocks.
contract ForgeCallsTest is BaseTest {
    IB20 quarx; IB20 bux; IB20 lex; uint64 citizens;

    function _calls(uint64 pid) internal returns (bytes memory pol, bytes[] memory toks) {
        string[] memory cmd = new string[](4);
        cmd[0] = "node"; cmd[1] = "../test/forge-calls.cjs"; cmd[2] = vm.toString(admin); cmd[3] = vm.toString(uint256(pid));
        (pol, toks) = abi.decode(vm.ffi(cmd), (bytes, bytes[]));
    }
    function _send(address to, bytes memory data) internal returns (bytes memory ret) {
        vm.prank(admin); bool ok; (ok, ret) = to.call(data); require(ok, "call failed");
    }
    function setUp() public override {
        super.setUp();
        (bytes memory pol,) = _calls(0);
        citizens = abi.decode(_send(StdPrecompiles.POLICY_REGISTRY_ADDRESS, pol), (uint64));
        (, bytes[] memory toks) = _calls(citizens);
        quarx = IB20(abi.decode(_send(StdPrecompiles.B20_FACTORY_ADDRESS, toks[0]), (address)));
        bux = IB20(abi.decode(_send(StdPrecompiles.B20_FACTORY_ADDRESS, toks[1]), (address)));
        lex = IB20(abi.decode(_send(StdPrecompiles.B20_FACTORY_ADDRESS, toks[2]), (address)));
        vm.startPrank(admin);   // the founder grants herself minting only to test; the page grants nothing
        quarx.grantRole(B20Constants.MINT_ROLE, admin); bux.grantRole(B20Constants.MINT_ROLE, admin); lex.grantRole(B20Constants.MINT_ROLE, admin);
        vm.stopPrank();
    }
    function test_citizensPolicyIsAnAllowlistOwnedByTheFounder() public view {
        assertTrue(StdPrecompiles.POLICY_REGISTRY.policyExists(citizens));
        assertEq(StdPrecompiles.POLICY_REGISTRY.policyAdmin(citizens), admin);
        assertFalse(StdPrecompiles.POLICY_REGISTRY.isAuthorized(citizens, alice));
    }
    function test_metadataAndAdmin() public view {
        assertEq(quarx.name(), "QuarX"); assertEq(quarx.symbol(), "QUARX"); assertEq(quarx.decimals(), 18);
        assertEq(bux.name(), "BuX"); assertEq(bux.symbol(), "BUX"); assertEq(bux.decimals(), 6);
        assertEq(lex.name(), "Lex"); assertEq(lex.symbol(), "LEX"); assertEq(lex.decimals(), 6);
        assertTrue(quarx.hasRole(bytes32(0), admin) && bux.hasRole(bytes32(0), admin) && lex.hasRole(bytes32(0), admin));
        assertEq(quarx.totalSupply() + bux.totalSupply() + lex.totalSupply(), 0);
    }
    function test_quarxCappedAtOneBillion() public {
        assertEq(quarx.supplyCap(), 1e9 * 1e18);
        vm.prank(admin); quarx.mint(alice, 1e9 * 1e18);
        vm.prank(admin); vm.expectRevert(); quarx.mint(alice, 1);
        vm.prank(alice); quarx.transfer(bob, 5e18); assertEq(quarx.balanceOf(bob), 5e18);   // QuarX moves freely
    }
    function test_buxOnlyForCitizensAndPaused() public {
        vm.prank(admin); vm.expectRevert(); bux.mint(alice, 1e6);                      // alice is not a citizen
        address[] memory list = new address[](2); list[0] = alice; list[1] = bob;
        vm.prank(admin); StdPrecompiles.POLICY_REGISTRY.updateAllowlist(citizens, true, list);
        vm.prank(admin); bux.mint(alice, 10e6); assertEq(bux.balanceOf(alice), 10e6);
        vm.prank(alice); vm.expectRevert(); bux.transfer(bob, 1e6);                     // transfers paused (A4)
        IB20.PausableFeature[] memory f = new IB20.PausableFeature[](1); f[0] = IB20.PausableFeature.TRANSFER;
        vm.prank(admin); bux.grantRole(B20Constants.UNPAUSE_ROLE, admin); vm.prank(admin); bux.unpause(f);
        vm.prank(alice); bux.transfer(bob, 1e6); assertEq(bux.balanceOf(bob), 1e6);   // between citizens, once unpaused
        vm.prank(alice); vm.expectRevert(); bux.transfer(attacker, 1e6);              // never to a non-citizen
    }
    function test_lexNeverTransfers() public {
        vm.prank(admin); lex.mint(alice, 3e6); assertEq(lex.balanceOf(alice), 3e6);
        vm.prank(alice); vm.expectRevert(); lex.transfer(bob, 1e6);
    }
    function test_nobodyElseIsAdmin() public {
        vm.prank(attacker); vm.expectRevert(); quarx.mint(attacker, 1);
        vm.prank(attacker); vm.expectRevert(); bux.updatePolicy(B20Constants.TRANSFER_SENDER_POLICY, 0);
    }
}
