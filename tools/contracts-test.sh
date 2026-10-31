#!/bin/sh
# Tests Xland's Base contracts and the Forge page's calldata (r57).
# Needs Foundry 1.8.4 or later (forge). Dependencies are pinned and fetched from GitHub on first run.
set -e
cd "$(dirname "$0")/../contracts"
mkdir -p lib
[ -d lib/openzeppelin-contracts ] || git clone -q --depth 1 --branch v5.1.0 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
[ -d lib/forge-std ] || git clone -q --depth 1 --branch v1.9.4 https://github.com/foundry-rs/forge-std lib/forge-std
[ -d lib/base-std ] || git clone -q --depth 1 https://github.com/base/base-std lib/base-std
forge test "$@"
