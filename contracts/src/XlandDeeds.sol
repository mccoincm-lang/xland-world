// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title Xland Deeds
/// @notice One NFT per parcel or lot of Xland's land registry (src/world.json), e.g. "FX-L-001".
/// - Minted only by MINTER_ROLE (the Xland Port, when a citizen moves a deed to their wallet).
/// - Moved only by LAND_OFFICE_ROLE (Xland's land office), so the resale floor, the anti-flip fee and the
///   lot cap always apply. Holders cannot transfer or approve a deed themselves.
/// - The House on the River (AQX-01) is eternal: it can never be minted, by anyone, ever.
contract XlandDeeds is ERC721, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant LAND_OFFICE_ROLE = keccak256("LAND_OFFICE_ROLE");
    uint256 public constant HOUSE_ON_THE_RIVER = uint256(keccak256("AQX-01"));

    mapping(uint256 => string) public parcelOf;
    string private baseURI_;

    error Eternal();
    error EmptyParcel();
    error TransfersOnlyThroughLandOffice();
    error NotHeldByCaller();

    event BaseURIUpdated(string uri);

    constructor(address admin, string memory uri) ERC721("Xland Deeds", "XDEED") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        baseURI_ = uri;
    }

    /// @notice The token id of a parcel: keccak256 of its registry id.
    function idOf(string calldata parcel) public pure returns (uint256) {
        return uint256(keccak256(bytes(parcel)));
    }

    function mint(address to, string calldata parcel) external onlyRole(MINTER_ROLE) returns (uint256 id) {
        if (bytes(parcel).length == 0) revert EmptyParcel();
        id = idOf(parcel);
        if (id == HOUSE_ON_THE_RIVER) revert Eternal();
        parcelOf[id] = parcel;
        _safeMint(to, id); // reverts if the deed already exists
    }

    /// @notice The Port burns a deed it holds when a citizen brings it back into the world.
    function burn(uint256 id) external onlyRole(MINTER_ROLE) {
        if (ownerOf(id) != msg.sender) revert NotHeldByCaller();
        _burn(id);
    }

    function setBaseURI(string calldata uri) external onlyRole(DEFAULT_ADMIN_ROLE) {
        baseURI_ = uri;
        emit BaseURIUpdated(uri);
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return string.concat(baseURI_, parcelOf[id]);
    }

    /// Holders never move deeds; the land office moves them without an approval.
    function _update(address to, uint256 id, address auth) internal override returns (address) {
        address from = _ownerOf(id);
        bool office = hasRole(LAND_OFFICE_ROLE, msg.sender);
        if (from != address(0) && to != address(0) && !office) revert TransfersOnlyThroughLandOffice();
        return super._update(to, id, office ? address(0) : auth);
    }

    function approve(address, uint256) public pure override {
        revert TransfersOnlyThroughLandOffice();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert TransfersOnlyThroughLandOffice();
    }

    function supportsInterface(bytes4 id) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(id);
    }
}
