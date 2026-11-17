# Collaboration and client review

Development plan PR 24 (creative collaboration and client review).

## Roles

| Role | Who | Can |
| --- | --- | --- |
| Owner | workspace OWNER/ADMIN | everything, invite/remove collaborators, decide approvals |
| Editor | workspace MEMBER or invited EDITOR | every wizard step and generation, comment, request approval |
| Reviewer | invited REVIEWER | review board: view shots and cuts, timecoded comments, approve / request changes |
| Viewer | invited VIEWER | review board read-only |

Editor write access is enforced in every project service through
`projectEditorWhere()` (`src/lib/collaboration/access.ts`), which admits workspace
members or an unexpired EDITOR grant for that one project. Collaborators never
get access to the owner's other projects, creative library or kits.

## Invitations

`/app/projects/:id/share` (owner only) creates a single-use link
(`/app/invite/:token`). Only a SHA-256 hash of the token is stored; the link
expires after 7 days, can be revoked, must be accepted by an account whose email
matches the invitation, and can carry an access end date (1–365 days). Expired
grants stop working at query time. There is no outbound email: the owner copies
the link (no SMTP provider is configured).

## Review board

`/app/projects/:id/review` lists approval requests, whole-project comments, cuts
(timeline versions with duration/item counts) and shots (latest version with
planned timing). Comments are threaded, can carry a `m:ss.mmm` timecode, and can
be resolved. Editors request approval on a shot, cut or the project (one pending
request per item); reviewers or the owner approve or request changes; a
requester cannot approve their own request unless they are the owner.

Conflict handling: comment edits, thread resolution and approval decisions name
the revision they saw; a stale revision returns HTTP 409 and the board reloads.

Tests: `src/lib/collaboration/access.test.ts`, `npm run test:collaboration`.
