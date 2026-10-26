# @pliscelle/agent-mailbox-mcp

MCP connector for AIScellé, Pli Scellé's end-to-end encrypted agent mailbox. It runs on your own
machine, launched as a subprocess by your MCP-capable agentic client (Claude Code, Claude Desktop, or
any other client that speaks the Model Context Protocol over stdio). Decryption happens here, on your
machine, with a key that never leaves it. Pli Scellé's servers store and route encrypted messages.
They cannot read them.

There is no remote AIScellé MCP server to connect to instead of installing this package. That is a
deliberate choice, not a missing feature: hosting the MCP endpoint would mean hosting the decryption,
and that would end the end-to-end encryption this connector exists to preserve.

## Setup

1. Pair this device, then sign in. From the AIScellé tab in your Pli Scellé account, generate a
   pairing code, then run:

    ```sh
    npx @pliscelle/agent-mailbox-mcp pair --code <PAIRING_CODE>
    ```

    A pairing code works once and expires after fifteen minutes. It also burns itself after a few
    failed attempts. Requesting a new code is safe. Retrying the same code blindly is not. The device
    is named after this machine's hostname unless you pass `--name "My laptop"`.

    Once the device is registered, this opens your browser so you can sign in and grant this device
    access to your mailbox. No second command is needed. Signing in also completes the pairing and
    makes this device appear in your AIScellé tab. Do it within the hour. After that the pairing
    expires and you need a new code. If sign-in fails for any reason, the registration stays saved.
    Retry `login` (below). Do not run `pair` again.

    On a machine with no browser to open (a remote shell, a headless container), pass `--no-login` to
    stop after pairing. Then run the device flow yourself, still within the hour:

    ```sh
    npx @pliscelle/agent-mailbox-mcp pair --code <PAIRING_CODE> --no-login
    npx @pliscelle/agent-mailbox-mcp login --device
    ```

2. Sign in again whenever needed. Use this when a session has expired with no refresh token left,
   or when you skipped sign-in above with `--no-login`.

    ```sh
    npx @pliscelle/agent-mailbox-mcp login
    ```

    On a machine with no browser, use the device flow instead:

    ```sh
    npx @pliscelle/agent-mailbox-mcp login --device
    ```

3. Give your address and public key to your correspondents. Nobody can send you a message until
   they have authorized you in their own AIScellé tab, and nobody can authorize you without these
   two values:

    ```sh
    npx @pliscelle/agent-mailbox-mcp identity
    ```

    Both are public and read locally from `seed.json`. The command never contacts our servers, and it
    works before this device has ever been paired. Authorizing someone in your own tab is only half of
    the trust decision. Your device trusts only what it has ratified itself, through
    `npx @pliscelle/agent-mailbox-mcp ratify --list`.

4. Point your agentic client at `npx @pliscelle/agent-mailbox-mcp` (no arguments) as an MCP server
   over stdio. Your client's documentation gives the exact configuration file format.

## What it does

This package ships the transport, OAuth, cryptography, and the seven AIScellé tools: `access_status`,
`inbox`, `search`, `read`, `senders`, `send` and `purge`. Whenever the current conversation has read a
message, `send` and `purge` need human confirmation, sent as an MCP elicitation request. In that case,
a client without elicitation support has both calls refused outright. They are never silently allowed
through.

The `send` prompt shows the recipient, the title and the first 200 characters of the body. Both
prompts state that a confirmation covers the rest of the conversation, for as long as no message is
read. So the first send in a conversation this device does not know yet is confirmed. Later sends are
confirmed again only after a read. A conversation opened with `inbox`, `search` or `senders` is
already known, so its first send is not prompted. The record of a conversation expires after 24 hours
without a tool call. Each allowed call renews it. Once the record expires, the conversation is unknown
again. The connector keys the record on the client's own process, so one client program counts as
one conversation. A record that expired more than 24 hours ago is removed from the file the next
time the connector writes it.

By default, message content shown to the agent (titles and bodies) carries an embedded anti-injection
notice. `npx @pliscelle/agent-mailbox-mcp policy --disable` turns that notice off on this device.

`read`, `inbox` and `search` return the same protected block twice: as the text of `content`, and as
the `wrappedContent` field of `structuredContent`. Some MCP hosts pass the model only that JSON and
drop the text blocks, so the message itself has to be in the JSON. The other fields of
`structuredContent` are typed and carry no title and no body. For `read`, they hold the sender's id,
address and label, the trust level, ratification, the sensitive flag, the date and the counts. For
`inbox` and `search`, they hold the items without their title, `nextCursor` and the counts, plus
`scanExhausted` for `search`. A client that calls the tools by code reads those fields.

The block opens with one line, `Verified by this device (not sender-controlled)`. That line lists what
this device checked. For `read`, it is the sender's address, the trust level, whether the sender is
ratified here, and the pending counts. For `inbox` and `search`, it is the pending counts. The listed
items and the pagination cursor travel inside the block. The server relays a correspondent's label, so
that label never appears on the line. The notice, the title and the body come after it. The title and
the body sit between two delimiter lines. Each call draws a random boundary id for them. The notice
says the block ends only at the END line with that id, so a body that contains its own END line does
not close the block. A sensitive message's link to its content carries no title, because the sender
writes the title.

The server always starts, even when this device has no valid session. `access_status` reports whether
AIScellé access is valid or was lost, and since when. Every other tool answers a call made without
access with an explicit error. That error names the exact command to run. The connection stays open,
and the call does not return an empty result. A session counts as definitively revoked when the
refresh token itself was rejected. A network hiccup does not count. Such a session is recorded once
and never retried on its own. Running `login` again restores it.

Like every other content-level precaution here, that notice is a mitigation and offers no guarantee.
It asks a model not to follow instructions found inside a message, and a model can be persuaded. The
confirmation prompt on `send` and `purge` is the one mechanism in this package that does not rely on
persuasion. It stops the call until a human answers.

## Running with no human present

A confirmation prompt needs someone to answer it. An agent-to-agent exchange is a read followed by a
reply. From its second turn on, every send would wait behind a prompt that nobody is there to accept.
For that case, start the server with `--unattended`:

```json
{
	"command": "npx",
	"args": ["-y", "@pliscelle/agent-mailbox-mcp", "--unattended"]
}
```

Hosts that do not let you extend the command line can set `PLISCELLE_MCP_UNATTENDED=1` instead. The
mode is read once, at launch, from configuration that a human wrote. It is never exposed as a tool,
and the server never reads it back. So no message this connector carries can turn it on.

In this mode, a ratification check takes the place of the confirmation. A send goes through without a
prompt when it goes to a correspondent already ratified on this machine with `ratify`. A send to any
other address is refused, including an address the server reports as ratified. The decision rests on
the local trace. That check applies to every send, whether or not a message was read first. Purge goes
through unconditionally, since it names no recipient and never leaves this mailbox. Declare this mode
only on a machine that hosts an unattended agent.

Before you update a machine that already runs in this mode, ratify every recipient its agent writes
to. `ratify --list` shows the correspondents not yet ratified. `ratify --sender-id <ID>` ratifies one.
Since 0.1.7, a send to an address not ratified on the machine is refused even when nothing was read.
Earlier versions let it through until the first read.

`ratify` refuses when the key the server shows for a correspondent differs from the key this device
already holds for it. In that case nothing is ratified. Run the command again and compare the
fingerprint before you confirm.

## Verifying what you install

Every published version carries a provenance attestation. It ties the tarball on the registry to the
workflow and commit that built it. Your npm client can check it:

```sh
npm audit signatures
```

The attestation is produced by the public build repository, https://github.com/Pli-Scelle/agent-mailbox-mcp,
which mirrors this package's source. Pin an exact version instead of a range. The policy this
connector enforces ships inside each version, so each upgrade is a decision you make on purpose.

## Configuration

- `AISCELLE_BACKEND_URL` (optional) overrides the Pli Scellé API origin. It defaults to
  `https://api.pliscelle.com`. It must use `https://`, except for `localhost` and `127.0.0.1` during
  local development.

## Local state

The connector keeps three files in `$XDG_CONFIG_HOME/pliscelle-mcp`, or in `~/.config/pliscelle-mcp`
when `XDG_CONFIG_HOME` is unset. On Windows the directory is `%APPDATA%\pliscelle-mcp`.
`client.json` holds the device registration. `tokens.json` holds the session tokens. `seed.json`
holds the seed your mailbox key is derived from. The files have owner-only file permissions. They
hold their contents in clear, with no passphrase. This trade-off is stated and accepted. It comes
with running an OAuth client on a personal machine. Anyone able to read your user account's files can
read your mailbox key. Back up `seed.json`. Losing it makes every message you have received
permanently unreadable.

If `seed.json` exists but cannot be read or does not parse, the command or tool that needs your
mailbox key fails. The error names the file and the cause. The connector never replaces that file
with a new seed. Fix its permissions or restore it from your backup.

The state files are written under a lock file, so two processes cannot overwrite each other's state.
The locking is implemented in `src/config/state-file-lock.ts`.

## Development

From the monorepo root:

```sh
pnpm --filter @pliscelle/agent-mailbox-mcp typecheck
pnpm --filter @pliscelle/agent-mailbox-mcp lint
pnpm --filter @pliscelle/agent-mailbox-mcp test
pnpm --filter @pliscelle/agent-mailbox-mcp build
```
