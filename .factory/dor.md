# Definition of Ready: software-factory

An item is ready for the factory to build when every line below holds.

- [ ] Every acceptance criterion can become a Given/When/Then scenario that a test can check.
- [ ] The item names the plan task or spec section it implements.
- [ ] The item fits one Sprint.
- [ ] An item that changes the factory's own rules names the spec section it changes. Those rules are the state machine in spec §5, the engine mechanics that spec §6 lists as states, leases, the scenario lock, red proof, approval counting and path floors, what a stage in the §6 stage table does, and the policy file format. WIP and scheduling in §7 and the dashboard in §8 are not among them, so an item that touches only those needs no §5 or §6 citation.
