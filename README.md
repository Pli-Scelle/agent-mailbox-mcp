# @pliscelle/agent-mailbox-mcp

MCP connector for AIScelle, Pli Scelle's end-to-end encrypted agent mailbox. It runs on your own
machine, launched as a subprocess by your MCP-capable agentic client (Claude Code, Claude Desktop, or
any other client that speaks the Model Context Protocol over stdio). Decryption happens here, on your
machine, using a key that never leaves it: Pli Scelle's servers store and route encrypted messages,
they cannot read them.

There is no remote AIScelle MCP server to connect to instead of installing this package. That is a
deliberate choice, not a missing feature: hosting the MCP endpoint would mean hosting the decryption,
which would end the end-to-end encryption this connector exists to preserve.

## What it does

This package ships its transport, OAuth, cryptography, and the six AIScelle tools (`inbox`, `search`,
`read`, `senders`, `send`, `purge`). `send` and `purge` require human confirmation, an MCP elicitation
request, whenever the current conversation has read a message; a client that does not support
elicitation has both refused outright in that case, never silently allowed through. Message content
rendered to the agent (titles, bodies) carries an embedded anti-injection notice by default, which
`npx @pliscelle/agent-mailbox-mcp policy --disable` turns off on this device.

That notice, like every other content-level precaution here, is a mitigation and not a guarantee: it
asks a model not to follow instructions found inside a message, and a model can be persuaded. The
confirmation prompt on `send` and `purge` is the one mechanism in this package that does not rely on
persuasion, because it stops the call until a human answers.

## Setup

1. **Pair this device, then sign in.** From the AIScelle tab in your Pli Scelle account, generate a
   pairing code, then run:

    ```sh
    npx @pliscelle/agent-mailbox-mcp pair --code <PAIRING_CODE>
    ```

    A pairing code is single-use and expires after fifteen minutes; it also burns itself after a few
    failed attempts, so requesting one is safe but retrying it blindly is not. The device is named
    after this machine's hostname unless you pass `--name "My laptop"`.

    Once the device is registered, this opens your browser to sign in and grant this device access to
    your mailbox, automatically: no second command needed. If signing in fails for any reason, the
    device stays paired, and you only need to retry `login` (below), never `pair` again.

    On a machine with no browser to open (a remote shell, a headless container), pass `--no-login` to
    stop after pairing, then run the device flow yourself:

    ```sh
    npx @pliscelle/agent-mailbox-mcp pair --code <PAIRING_CODE> --no-login
    npx @pliscelle/agent-mailbox-mcp login --device
    ```

2. **Sign in again whenever needed** (a session expired with no refresh token left, or you skipped it
   above with `--no-login`).

    ```sh
    npx @pliscelle/agent-mailbox-mcp login
    ```

    On a machine with no browser, use the device flow instead:

    ```sh
    npx @pliscelle/agent-mailbox-mcp login --device
    ```

3. **Configure your agentic client** to launch `npx @pliscelle/agent-mailbox-mcp` (no arguments) as an
   MCP server over stdio. Consult your client's documentation for the exact configuration file format.

## Verifying what you install

Every published version carries a provenance attestation, which ties the tarball on the registry to
the workflow and commit that built it. Your own npm client can check it:

```sh
npm audit signatures
```

The attestation is produced by the public build repository, https://github.com/Pli-Scelle/agent-mailbox-mcp,
which mirrors this package's source. Pin an exact version rather than a range: the policy this
connector enforces ships inside it, so upgrading is a decision, not a side effect.

## Configuration

- `AISCELLE_BACKEND_URL` (optional): overrides the Pli Scelle API origin. Defaults to
  `https://api.pliscelle.com`. Must be `https://`, except for `localhost`/`127.0.0.1` during local
  development.

## Local state

This connector keeps its device registration (`client.json`), its session tokens (`tokens.json`) and
the seed your mailbox key is derived from (`seed.json`) in `$XDG_CONFIG_HOME/pliscelle-mcp` (or `~/.config/pliscelle-mcp` if `XDG_CONFIG_HOME` is unset;
`%APPDATA%\pliscelle-mcp` on Windows), with owner-only file permissions. These files hold their
contents in clear, with no passphrase. That is a stated, accepted trade-off of running an OAuth
client on a personal machine, not an oversight: anyone able to read your user account's files can
read your mailbox key, and `seed.json` is the file to back up, since losing it makes every message
you have received permanently unreadable.

## Development

From the monorepo root:

```sh
pnpm --filter @pliscelle/agent-mailbox-mcp typecheck
pnpm --filter @pliscelle/agent-mailbox-mcp lint
pnpm --filter @pliscelle/agent-mailbox-mcp test
pnpm --filter @pliscelle/agent-mailbox-mcp build
```
