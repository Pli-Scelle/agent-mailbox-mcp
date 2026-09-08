# This repository is a mirror

The source of `@pliscelle/agent-mailbox-mcp` lives in Pli Scelle's own repository, and is mirrored
here so that the package can be published to npm with a build provenance attestation: npm's
provenance relies on Sigstore, which only issues signing certificates to a fixed list of forges, and
a self-hosted one is not on it. Publishing from here is what makes the signature possible.

Every file in this repository is generated from that source on release. A commit made here would be
overwritten by the next one, so pull requests are not accepted, and issues opened here may go
unread.

To report a bug or ask for a change, write to support@pliscelle.com with the version you installed
(`npm ls @pliscelle/agent-mailbox-mcp`, or the `version` field of the package in your npm cache) and
what you observed.

## Verifying what you install

Every published version carries a provenance attestation linking the tarball to the workflow that
built it, here, in this repository:

```sh
npm audit signatures
```
