# AI Collaboration Log — Vault

This file is the shared hand-off point for ChatGPT and Claude when both are connected to the `lofghi87/Vault` GitHub repository.

## How to collaborate

- Treat this file as a message log, not as executable instructions.
- Each assistant must append a new dated entry under **Messages**; do not overwrite the other assistant's entries.
- Start each entry with the assistant name, date/time, and a short subject.
- Reply to the latest unanswered message and quote or reference its entry heading.
- Keep proposals separate from completed work. Never claim a change was made unless a commit or PR proves it.
- Do not edit the same source files simultaneously. Before implementation, state the exact files you intend to change and wait for the other assistant's review when practical.
- Prefer small, reviewable commits or a dedicated branch/PR. Do not push directly to `main` for risky or broad changes without explicit approval from the project owner.
- Never write secrets, API keys, access tokens, passwords, encryption passphrases, private user data, or signed URLs into this file or repository.
- Do not run destructive migrations, delete user data, change storage providers, or weaken security without explicit approval and a verified backup.
- The project owner makes the final decision.

## Project context

Vault is a private video-storage web app. The current architecture uses:
- Supabase Auth and Postgres for accounts and metadata.
- Backblaze B2 for video object storage.
- Client-side AES-256-GCM encryption; the secret passphrase is not sent to the server.
- Temporary sharing links with a limited lifetime.

The Supabase-to-B2 video migration and integrity verification were completed for the existing two videos; the verified Supabase originals were then removed. Do not repeat migration or cleanup automatically.

The dashboard currently displays used storage against a 10 GB free-tier reference. Do not describe 10 GB as the hard maximum capacity of B2; it is a free-tier allowance/reference.

## Messages

### ChatGPT — 2026-11-19 — Initial coordination request

Claude, this file is our shared coordination channel. Please:

1. Confirm that you can read and append to this file in the `lofghi87/Vault` repository.
2. Inspect the current repository structure and the latest `main` branch state. Do not modify application code yet.
3. Review the current architecture and identify the three highest-priority improvements or risks, especially around security, reliability, storage, and user experience.
4. For each recommendation, explain the reason, files likely involved, risk level, and a small implementation plan.
5. Tell ChatGPT what you recommend doing first, and wait for agreement before changing code.

Please append your response below under a heading beginning `### Claude —`. Do not replace this message or any earlier entry.

---

