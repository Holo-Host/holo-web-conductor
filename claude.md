# Fishy

## Overview

This project is a browser extention-based implementation of the Holochain conductor as implemented in https://github.com/holochain/holochain/ as well as lair keystore as implemented in https://github.com/holochain/lair.

The Holochain repo is a large mono-repo and the portions to be implemented here would be the ability for a browser based UI to run a holochain hApp wasm in the browser and have the extension take on the host side actions which sign and store source chain data along with making network calls for which it will have a different http gateway based approach rather than using the network protocols as defined in kitsune2.

## Assumptions that differentiate this implementation from the full distributed Holochain implementation

1. These nodes do not gossip, they are considered zero-arc and thus get all data from the network (though they may cache data especially content-addressable data)
2. The identifying context of the hApp is directly obtained from the domain name from which the happ UI and wasm is downloaded.
3. Agency (i.e. the private key pair) for a given hApp context is stored in a local data base mirroring Lair functionality for signing.
4. Node are not expected to have progenitor status on a Holochain network i.e. they are all operating in a context where other allways on nodes exist.
5. Bootstrapping?

## Planing 

This project will be developed in these overall stages:

1. create a working browser extension with a base API to take messages from web-pages to make requests of the extension.
2. implement the functionality in the extension that map to calls that can be made to Lair keystore.
3. add an authentication mechanism whereby the end-user has to authorize a web page asking for connection to the extension to take actions, similar to how metamask requires approval before taking action.
4. add the ability to create a happ context based on data served from a web page once authorized.
5. add the ability to run a wasm under the happ context with the host-functions that match the host functions as implemented in https://github.com/holochain/holochain/tree/develop/crates/holochain/src/core/ribosome, where the functions themselves are mocked, i.e. don't actually store data for commits nor get data from the network, but provide actual working results given test wasms for different host functions that get called by the various hdk (https://github.com/holochain/holochain/tree/develop/crates/hdk) and hdi (https://github.com/holochain/holochain/tree/develop/crates/hdi) functions
6. implement the various host functions that write local chain data
7. implement any extension to https://github.com/holochain/hc-http-gw necessary to receive requests to publish commits to the network, assuming the context that web-based node is a zero arc node, i.e. not gossip networking is necessary
8. implement the various host functions that make networking requests
9. do integration testing with existing hApps


## Requirements

1. Each step of the process must be built using test-driven development practices such that CI can confirm no regressions before merging a PR
