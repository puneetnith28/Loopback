// The words around the recording: what each scene means, and the setup steps from docs/setup.md. Everything said
// in the chat rooms comes from the recording itself, never from here.

/** One entry per rehearsal scene, in order. The build fails if the counts differ. */
export const SCENE_GUIDE = [
  {
    what: "Switch delivered Prashant's message to the gate, because it was addressed to the gate. The gate opened case LB-001 and told the maintainers.",
    why: "A public report starts no agent. Bug reports can carry instructions aimed at an AI, so a person has to accept the report first.",
    console: ["See the new case", "/cases/LB-001"],
  },
  {
    what: "Refused. The public room has no approve command, for anyone.",
    why: "Authority depends on the room as well as the person. Even a maintainer can't approve from here.",
  },
  {
    what: "`team` asked Switch which agents are really connected. `accept` then tasked the fixer in the room, where everyone can see it, with the report fenced as untrusted data.",
    why: "The gate reaches its agents only by Switch message. Nothing started until a person said so.",
  },
  {
    what: "The fixer opened a pull request. The gate read it from GitHub, recorded the full commit, and asked the verifier about exactly that commit.",
    why: "Agents can say anything. The gate believes GitHub about what was pushed.",
    console: ["See the commit on the case", "/cases/LB-001"],
  },
  {
    what: "`why` lists every merge requirement, read live, with what is still missing.",
    why: "Anyone in the room can see why a merge can't happen yet, without opening another tool.",
  },
  {
    what: "Refused. The report claims a pass and carries a signature, but the signature doesn't match the verifier's key.",
    why: "A passing report only counts if it's signed by the verifier's key, for this run and this commit. A chat message alone proves nothing.",
  },
  {
    what: "CI passed and the real verifier reported, both on the same commit. Only now does the gate ask a person to approve.",
    why: "All evidence is tied to one commit. People are asked at the point where their decision can count.",
    console: ["See the evidence", "/cases/LB-001"],
  },
  {
    what: "Neither message got anywhere. Agents have no commands, and someone off the maintainers' list has no authority.",
    why: "Switch tells the gate the exact sender id. A display name can't be used to pretend.",
  },
  {
    what: "Refused. The approval named a commit that isn't the one on the pull request.",
    why: "An approval has to name the full 40-character commit. It means \"this commit is fine\", and nothing broader.",
  },
  {
    what: "Approved. The case is ready to merge, for this one commit.",
    why: "This is the only approval that counts so far, and it is recorded against the commit with the maintainer's Switch id.",
    console: ["See the approval", "/cases/LB-001"],
  },
  {
    what: "A new commit landed after the approval. When the maintainer said merge, the gate re-read GitHub, saw the new commit, refused, and threw the old evidence away.",
    why: "This is the point of Loopback. A normal chat approval would have let code nobody reviewed reach the base branch.",
    console: ["See the evidence reset", "/cases/LB-001"],
  },
  {
    what: "The same question now gives a different answer: the approval is for an older commit, and CI and the verifier have to run again.",
    why: "Nothing carries over from one commit to the next.",
  },
  {
    what: "The new commit passed CI, got its own signed report, and the maintainer approved that commit.",
    why: "The workflow recovers by itself once the evidence is earned again. Nobody has to clean up by hand.",
  },
  {
    what: "The gate checked everything against GitHub again, posted its own status, merged that exact commit, and then confirmed the result with GitHub.",
    why: "Only the gate's GitHub App can merge, and GitHub's rules enforce it. The merge call itself is tied to the commit.",
    console: ["See the merged case", "/cases/LB-001"],
  },
  {
    what: "The gate keeps a case board and a decision log as Switch room documents. Open Switch Console, then Documents, to read them.",
    why: "Everyone in the room reads the same record, and Switch lets only the gate rewrite it. Every refusal you just caused is in that log.",
    console: ["See the full audit history", "/audit"],
    tab: "switch",
  },
];

/** From docs/setup.md and the README. Commands only: their output differs between machines, so none is invented. */
export const SETUP_STEPS = [
  {
    title: "Get the code",
    where: "terminal",
    body: "You need Node 22. No accounts, tokens or Docker for this part.",
    lines: ["git clone https://github.com/puneetnith28/Loopback.git", "cd Loopback", "npm ci", "npm run build"],
  },
  {
    title: "Try it with no accounts",
    where: "transcript",
    body: "This runs the gate's real code against stand-ins for Switch, GitHub and the agents, and checks 16 outcomes. The text beside this is what it really prints. Most people can stop here and move on to the run.",
    lines: ["npm run demo"],
  },
  {
    title: "Install Switch Console",
    where: "switch",
    screen: "home",
    body: "From here on is the real setup, which takes a few hours the first time. Install Switch Console and complete its logins. It runs a local Switch server, with Mattermost as the chat app.",
  },
  {
    title: "Register the gate as an agent",
    where: "terminal",
    body: "The gate is a custom agent, so it is registered once with Switch's API. Keep the returned id and key in .env, outside any synced folder. They never go in git.",
    lines: ["POST http://127.0.0.1:<api port>/agents", "# keep the returned values in .env", "SWITCH_AGENT_ID=<id>", "SWITCH_AGENT_API_KEY=<key>"],
  },
  {
    title: "Import the Loopback template",
    where: "switch",
    screen: "templates",
    body: "In Switch Console, open Templates, choose Import template, pick templates/loopback.template.yaml, then Use. One file creates the fixer, the verifier, a private maintainers' room and a public intake room. The live Switch server accepted it with no warnings. It hasn't yet been run end to end, and our live rooms were made by hand.",
  },
  {
    title: "Set who may address the gate",
    where: "terminal",
    body: "An administrator sets two addressing rules in Switch. Only named maintainers and the two agents may address the gate in the maintainers' room. Anyone may address it in the public room. The gate checks these rules when it starts and every 60 seconds, and stops if they change.",
    lines: ["PUT /gateway/agents/<id>/addressing-policy", "", "rooms: [SWITCH_ROOM_ID]", "  users: [maintainer ids]", "  agents: [fixer and verifier ids]", "", "rooms: [SWITCH_INTAKE_ROOM_ID]", "  users: \"*\"", "  agents: []"],
  },
  {
    title: "Connect GitHub",
    where: "terminal",
    body: "Create a GitHub App for the gate, the only identity that can merge, and add rulesets that require its status. The fixer and verifier get their own limited tokens. Merging stays off until you turn it on.",
    lines: ["cp .env.example .env", "# fill in the GitHub App, tokens, room ids and maintainers", "# docs/setup.md lists every value", "", "LOOPBACK_PRIVILEGED_ENABLED=true", "MERGE_ENABLED=true"],
  },
  {
    title: "Start the gate",
    where: "terminal",
    body: "The readiness check lists anything still missing. Once the gate is running, the team works entirely in the chat rooms, which is the next part of this page.",
    lines: ["npm run migrate", "npm run readiness    # lists anything still missing", "npm run gate"],
  },
];

/** Real code shown in the "How it's built" section, cut from the source at build time. */
export const CODE_EXCERPTS = [
  {
    title: "The gate connects to Switch as an agent",
    note: "One WebSocket per room, over Switch's agent protocol. This connection is the only way a message reaches the gate.",
    file: "apps/switch-gate/src/switch/connection.ts",
    from: /protocol: String\(AGENT_PROTOCOL\),/,
    to: /connection\/ws\?/,
  },
  {
    title: "What Switch says about the sender decides what happens",
    note: "Every message passes this check first. It decides from the room, sender id and addressing facts that Switch supplies.",
    file: "apps/switch-gate/src/policy/admission.ts",
    from: /export function admit\(/,
    to: /msg\.addressed !== true/,
  },
  {
    title: "A new commit voids the evidence",
    note: "Before any merge, the gate compares what it has on record with what GitHub says right now.",
    file: "apps/switch-gate/src/policy/evaluate.ts",
    from: /const head = pr\.headSha;/,
    to: /stale\("HEAD_MOVED"/,
    after: 1,
  },
];
