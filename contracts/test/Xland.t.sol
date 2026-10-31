// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {Test} from "forge-std/Test.sol";
import {XlandDeeds} from "../src/XlandDeeds.sol";
import {XlandPassport} from "../src/XlandPassport.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract DeedsTest is Test {
    XlandDeeds d; address admin = address(0xA11CE); address port = address(0xB0B); address office = address(0x0FF1CE);
    address alice = address(0xA1); address bob = address(0xB2);
    function setUp() public {
        d = new XlandDeeds(admin, "https://xland.world/api/deed/");
        vm.startPrank(admin); d.grantRole(d.MINTER_ROLE(), port); d.grantRole(d.LAND_OFFICE_ROLE(), office); vm.stopPrank();
    }
    function test_adminOnlyFounder() public view { assertTrue(d.hasRole(0x00, admin)); assertFalse(d.hasRole(0x00, address(this))); }
    function test_mintAndURI() public { vm.prank(port); uint256 id = d.mint(alice, "FX-L-001"); assertEq(d.ownerOf(id), alice); assertEq(d.tokenURI(id), "https://xland.world/api/deed/FX-L-001"); assertEq(id, d.idOf("FX-L-001")); }
    function test_houseOnTheRiverNeverMinted() public { vm.prank(port); vm.expectRevert(XlandDeeds.Eternal.selector); d.mint(alice, "AQX-01"); bytes32 r = d.MINTER_ROLE(); vm.prank(admin); d.grantRole(r, admin); vm.prank(admin); vm.expectRevert(XlandDeeds.Eternal.selector); d.mint(admin, "AQX-01"); }
    function test_onlyMinterMints() public { vm.prank(alice); vm.expectRevert(); d.mint(alice, "FX-L-002"); }
    function test_noDoubleMint() public { vm.startPrank(port); d.mint(alice, "FX-L-003"); vm.expectRevert(); d.mint(bob, "FX-L-003"); vm.stopPrank(); }
    function test_holderCannotTransfer() public { vm.prank(port); uint256 id = d.mint(alice, "FX-L-004"); vm.prank(alice); vm.expectRevert(XlandDeeds.TransfersOnlyThroughLandOffice.selector); d.transferFrom(alice, bob, id); vm.prank(alice); vm.expectRevert(XlandDeeds.TransfersOnlyThroughLandOffice.selector); d.safeTransferFrom(alice, bob, id); }
    function test_noApprovals() public { vm.prank(port); uint256 id = d.mint(alice, "FX-L-005"); vm.prank(alice); vm.expectRevert(XlandDeeds.TransfersOnlyThroughLandOffice.selector); d.approve(bob, id); vm.prank(alice); vm.expectRevert(XlandDeeds.TransfersOnlyThroughLandOffice.selector); d.setApprovalForAll(bob, true); }
    function test_landOfficeMoves() public { vm.prank(port); uint256 id = d.mint(alice, "FX-L-006"); vm.prank(office); d.transferFrom(alice, bob, id); assertEq(d.ownerOf(id), bob); }
    function test_landOfficeNeedsRightFrom() public { vm.prank(port); uint256 id = d.mint(alice, "FX-L-007"); vm.prank(office); vm.expectRevert(); d.transferFrom(bob, office, id); }
    function test_portBurnsOnlyWhatItHolds() public { vm.prank(port); uint256 id = d.mint(alice, "FX-L-008"); vm.prank(port); vm.expectRevert(XlandDeeds.NotHeldByCaller.selector); d.burn(id); vm.prank(office); d.transferFrom(alice, port, id); vm.prank(port); d.burn(id); vm.expectRevert(); d.ownerOf(id); }
    function test_onlyAdminSetsURI() public { vm.prank(alice); vm.expectRevert(); d.setBaseURI("x"); vm.prank(admin); d.setBaseURI("ipfs://x/"); }
    function testFuzz_onlyAqxIsEternal(string calldata p) public { vm.assume(bytes(p).length > 0 && keccak256(bytes(p)) != keccak256("AQX-01")); vm.prank(port); d.mint(alice, p); }
}

contract PassportTest is Test {
    XlandPassport p; address admin = address(0xA11CE); address issuer = address(0xB0B); address alice = address(0xA1); address bob = address(0xB2);
    function setUp() public { p = new XlandPassport(admin, "https://xland.world/api/passport/"); bytes32 r = p.MINTER_ROLE(); vm.prank(admin); p.grantRole(r, issuer); }
    function test_issueOnePerCitizen() public { vm.prank(issuer); uint256 id = p.issue(alice); assertEq(id, 1); assertEq(p.passportOf(alice), 1); assertTrue(p.locked(1)); vm.prank(issuer); vm.expectRevert(XlandPassport.AlreadyCitizen.selector); p.issue(alice); }
    function test_soulbound() public { vm.prank(issuer); p.issue(alice); vm.prank(alice); vm.expectRevert(XlandPassport.Soulbound.selector); p.transferFrom(alice, bob, 1); vm.prank(alice); vm.expectRevert(XlandPassport.Soulbound.selector); p.approve(bob, 1); vm.prank(alice); vm.expectRevert(XlandPassport.Soulbound.selector); p.setApprovalForAll(bob, true); }
    function test_revokeAndReissue() public { vm.startPrank(issuer); p.issue(alice); p.revoke(1); assertEq(p.passportOf(alice), 0); uint256 id = p.issue(alice); vm.stopPrank(); assertEq(id, 2); }
    function test_onlyIssuer() public { vm.prank(alice); vm.expectRevert(); p.issue(alice); }
    function test_erc5192Interface() public view { assertTrue(p.supportsInterface(0xb45a3c0e)); assertTrue(p.supportsInterface(0x80ac58cd)); }
    function test_uri() public { vm.prank(issuer); p.issue(alice); assertEq(p.tokenURI(1), "https://xland.world/api/passport/1"); }
}
