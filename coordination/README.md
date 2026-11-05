# Private team coordination

The actual MIT-licensed source at https://github.com/pranjal2041/swarmchat is vendored at upstream commit 5ee0c0e307e7b58eb6aa881ee9a7b60d1ace5149. No third-party hosted account, paid plan, telemetry or runtime package download is used.

Python 3.9+ is required at runtime. Each job starts one short-lived localhost-only server on a random port with fresh opaque credentials, a private temporary folder and a private room. At most four rooms per Node process may run at once. Identity tokens and the viewer/admin token never leave the subprocess. The model can provide message text only, never identities, policy, paths or tool commands. Unknown identities are rejected. No listener is exposed through the web app.

The room is transport, not the customer system of record. NahaMind retains results in its existing account/browser chat state. HI retains plan steps and results in its tenant-RLS protected plans table. Room files are removed at job end. Failed jobs are reported, never replaced by canned answers. Disk loss/restart mid-job can interrupt that job; completed plan/chat results remain in their existing store. No cross-product/customer sharing is enabled. Existing send, booking, payment and account approval gates are unchanged. Team text remains untrusted context, never permission.

NahaMind: Bot Group Chat uses /api/team/round. The server assigns fixed identities, passes each worker the real private-room transcript, posts its output back, and streams completed turns to the customer. A follow-up starts a fresh isolated round from the customer-visible transcript, not a long-lived global room.
HI: every multi-step plan assigns each specialist a fixed identity and passes earlier worker messages through the real room. The lead reads those room messages to produce its summary. No external-contact model route gets a new messaging tool.

Run `node --test team-test.mjs` for real subprocess/network tests. The upstream suite was run separately: 186 passing. Customer labels are Team / teammates / private room; third-party branding is kept in this maintainer attribution only.
