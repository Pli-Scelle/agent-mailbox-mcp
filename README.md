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

This package ships its transport, OAuth, cryptography, and the seven AIScelle tools (`access_status`,
`inbox`, `search`, `read`, `senders`, `send`, `purge`). `send` and `purge` require human confirmation,
an MCP elicitation request, whenever the current conversation has read a message; a client that does
not support elicitation has both refused outright in that case, never silently allowed through. The
prompt for `send` shows the recipient, the title and the first 200 characters of the body, and both
prompts say that a confirmation covers the rest of the conversation for as long as no message is read:
the first send of a conversation this device does not know yet is confirmed, and the next ones are only
confirmed again after a read.
Message content rendered to the agent (titles, bodies) carries an embedded anti-injection notice by
default, which `npx @pliscelle/agent-mailbox-mcp policy --disable` turns off on this device.

`read`, `inbox` and `search` return the same protected block twice: as the text of `content`, and as
the `wrappedContent` field of `structuredContent`. Some MCP hosts hand the model that JSON alone and
drop the text blocks, so the message itself has to be in the JSON. The other fields of
`structuredContent` are typed and carry no title and no body: the sender's id, address and label,
the trust level, ratification, the sensitive flag, the date and the counts for `read`; the items
without their title, `nextCursor` and the counts (plus `scanExhausted` for `search`) for `inbox` and
`search`. A client that calls the tools by code reads those fields. The block opens with one line,
`Verified by this device (not sender-controlled)`, followed by what this device checked: for `read`,
the sender's address, the trust level, whether the sender is ratified here and the pending counts;
for `inbox` and `search`, the pending counts. The listed items and the pagination cursor travel
inside the block. A correspondent's label is relayed by the server, so it never appears on that
line. The notice, the title and the body come after it. The title and the body sit between two delimiter lines that carry a boundary id drawn at random on every call, and
the notice states that the block ends only at the END line bearing that id: a body that contains its
own END line does not close it. A sensitive message's link to its content carries no title, since a
title is written by the sender.

The server itself always starts, even when this device has no valid session: `access_status` reports
whether AIScelle access is valid or was lost (and since when), and every other tool answers a call made
without access with an explicit error naming the exact command to run, rather than closing the
connection or returning an empty result. A definitively revoked session (the refresh token itself was
rejected, not a network hiccup) is recorded once and is never retried on its own; running `login` again
is what restores it.

That notice, like every other content-level precaution here, is a mitigation and not a guarantee: it
asks a model not to follow instructions found inside a message, and a model can be persuaded. The
confirmation prompt on `send` and `purge` is the one mechanism in this package that does not rely on
persuasion, because it stops the call until a human answers.

## Running with no human present

A confirmation prompt needs someone to answer it. An agent-to-agent exchange is a read followed by a
reply, so from its second turn onwards every send would sit behind a prompt nobody is there to accept.
For that case, start the server with `--unattended`:

```json
{
	"command": "npx",
	"args": ["-y", "@pliscelle/agent-mailbox-mcp", "--unattended"]
}
```

Hosts that do not let you extend the command line can set `PLISCELLE_MCP_UNATTENDED=1` instead. The
mode is read once, at launch, from the configuration a human wrote; it is never exposed as a tool and
never read back from the server, so no message this connector carries can turn it on.

In this mode the confirmation is replaced, not removed. A send goes through without a prompt towards a
correspondent already ratified on this machine with `ratify`, and it is refused towards any other
address, including one the server reports as ratified: the local trace is what counts. That check
applies to every send, whether or not a message was read first. Purge goes through unconditionally,
since it names no recipient and never leaves this mailbox. Declare this mode only on a machine that
hosts an unattended agent.

Before updating a machine that already runs in this mode, ratify on it every recipient its agent writes
to (`ratify --list` shows the correspondents not yet ratified, `ratify --sender-id <ID>` ratifies one).
Since 0.1.7, a send to an address not ratified on the machine is refused even when nothing was read,
where earlier versions let it through until the first read.

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
    your mailbox, automatically: no second command needed. Signing in is also what finishes the
    pairing and makes this device appear in your AIScelle tab, so run it within the hour: after that
    the pairing expires and you need a new code. If it fails for any reason, the registration stays
    saved and you only need to retry `login` (below), never `pair` again.

    On a machine with no browser to open (a remote shell, a headless container), pass `--no-login` to
    stop after pairing, then run the device flow yourself, still within the hour:

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

3. **Give your address and public key to your correspondents.** Nobody can send you a message until
   they have authorized you in their own AIScelle tab, and nobody can authorize you without these two
   values:

    ```sh
    npx @pliscelle/agent-mailbox-mcp identity
    ```

    Both are public and read locally from `seed.json`; the command never contacts our servers, and it
    works before this device has ever been paired. Authorizing someone in your own tab is only half
    the trust decision: your device trusts nothing it has not ratified itself, with
    `npx @pliscelle/agent-mailbox-mcp ratify --list`.

4. **Configure your agentic client** to launch `npx @pliscelle/agent-mailbox-mcp` (no arguments) as an
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
