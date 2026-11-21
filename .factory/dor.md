# Definition of Ready: software-factory

An item is ready for the factory to build when every line below holds.

- [ ] Every acceptance criterion can become a Given/When/Then scenario that a test can check.
- [ ] The item names the plan task or spec section it implements.
- [ ] The item fits one Sprint.
- [ ] An item that changes the factory's own rules says so under a `## Changes the factory's rules` section. Each rule it changes gets its own heading: `### Spec §N` for a spec section, or `### ` and the policy file's path, such as `### .factory/dor.md` or `### policy/dor.md`, for a policy file. Under each heading, **Before** quotes the rule's current text word for word from `main`, and **After** gives the rule as it will read once the item ships, each as a `>` quote. The section has to cover every rule the item changes, and the item waits in NotReady until the owner approves the change on the item page. Those rules are the state machine in spec §5, the engine mechanics that spec §6 lists as states, leases, the scenario lock, red proof, approval counting and path floors, what a stage in the §6 stage table does, and the policy file format. WIP and scheduling in §7 and the dashboard in §8 are not among them, so an item that touches only those needs no such section.
