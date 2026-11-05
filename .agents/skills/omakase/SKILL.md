---
name: omakase
description: Aligns with the user on what to build and how before any code changes, presenting each choice as a numbered proposal. Use when the user asks for omakase.
---

# When the users asks for an omakase on a task.

- Your goal is to align with the user on a plan on how to achieve the task she is requesting.

- Start by doing enough thorough research of the codebase and the requested task for you to have a high quality opinion on what is the most idiomatic approach to achieve the users request.
Get ahead of any challenges you might run into while achieving the requested task. Continue reading code until it no longer helps writing great proposals.
When you're done with your research, write an update through commentary on which and how many files you read.

- You build alignment not by asking questions, but by writing the answer to a question you would ask in the form of a proposal.

- Each proposal numbered and paired with a background section. The background section contains rationale for your proposal, followed by "Alternatives:", and alternative options labelled A,B,C etc. The background section has a title like "Why not redis?" or "VNC Instead?".

- Order proposals by how much of the plan would change if the user pushed back on them, most first. Keep that order under each heading too.

- Don't ask the user for anything you could look up yourself.

- You pair each proposal with a background section that contains rationale, and alternatives. Alternatives are identified by A,B,C etc. Proposals are identified by 1,2,3, etc.


- Each proposal starts open, until the user accepts it. Then we call it a decision.

- After you present your first set of proposals to the user, the user will give you feedback.

- You will allow the user to be terse in his feedback / decision making, and will assume their intent. 

- Your next message after the user gives feedback on a set of proposals always starts with a single line that summarizes how you interpreted the users decision, and a tally of which proposals are still open.

- Unless the user requests otherwise, keep on coming with new rounds of proposals. Always re-include previous proposals that are still open.

- When the user pushes back on a proposal, assume they have not read beyond that proposal. You may rewrite / recycle the numbers of the proposals not read.

- Aim for 4–10 proposals per round. Leave later-stage choices for later rounds.

- The first time you present a set of proposals to the user, end it with this explanation on how they can choose to respond. Omit it all other times.
  ```markdown
  accept -> accepts all
  accept, but I don't know about 4.. -> accepts only proposals 1,2 & 3, assumes you have not read 5,6,7
  accept 3b --> accept 1 & 2, reject 3, instead take alternative 3b. assumes you have not read 4,5,6
  implement -> accepts all, leaves omakase mode, and starts implementing the agreed upon direction. 
  ```

### Where fold-outs go

The intent of this skill is to not overwhelm the user with background info / alternative choices for every proposal, but to have this information available should they want to read it.

We have two presentation options. Use the preferred technique only if your instructions or available skills describe a specific way to embed an HTML file in your reply, such as an `inline-content:` image reference or a `visualize` skill. Otherwise, use the fallback technique.

Never put `<details>` or any other HTML directly in your reply text. No host you run in is guaranteed to render it.

### Preferred presentation technique
Write an inline visualization that is a list of the proposals, with each proposal having a <details> that contains the background section right next to it.  background sections always start collapsed.
Do not repeat the proposals, you only write them once.

### Fallback Presentation technique
Write a html file into a temporary location that has pairs of proposal + background-section in foldout. Then also respond with the proposals without background sections inline, and after every proposal emit a link to the html file at the correct anchor, that when clicked, will open the html file at that proposals foldout. background sections always start collapsed. use `./fallback-render.html` as a template.

