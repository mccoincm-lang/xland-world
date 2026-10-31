// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title Xland Passport
/// @notice Proof of citizenship: one soulbound (ERC-5192) passport per verified citizen wallet.
/// Issued and revoked only by MINTER_ROLE; never transferable, never approvable.
contract XlandPassport is ERC721, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    uint256 public nextId = 1;
    mapping(address => uint256) public passportOf;
    string private baseURI_;

    error Soulbound();
    error AlreadyCitizen();

    /// ERC-5192
    event Locked(uint256 tokenId);
    event BaseURIUpdated(string uri);

    constructor(address admin, string memory uri) ERC721("Xland Passport", "XPASS") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        baseURI_ = uri;
    }

    function issue(address to) external onlyRole(MINTER_ROLE) returns (uint256 id) {
        if (passportOf[to] != 0) revert AlreadyCitizen();
        id = nextId++;
        passportOf[to] = id;
        _safeMint(to, id);
        emit Locked(id);
    }

    function revoke(uint256 id) external onlyRole(MINTER_ROLE) {
        delete passportOf[ownerOf(id)];
        _burn(id);
    }

    /// ERC-5192: every passport is locked to its holder.
    function locked(uint256 id) external view returns (bool) {
        _requireOwned(id);
        return true;
    }

    function setBaseURI(string calldata uri) external onlyRole(DEFAULT_ADMIN_ROLE) {
        baseURI_ = uri;
        emit BaseURIUpdated(uri);
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return string.concat(baseURI_, Strings.toString(id));
    }

    function _update(address to, uint256 id, address auth) internal override returns (address) {
        address from = _ownerOf(id);
        if (from != address(0) && to != address(0)) revert Soulbound();
        return super._update(to, id, auth);
    }

    function approve(address, uint256) public pure override {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    function supportsInterface(bytes4 id) public view override(ERC721, AccessControl) returns (bool) {
        return id == 0xb45a3c0e || super.supportsInterface(id); // ERC-5192
    }
}
