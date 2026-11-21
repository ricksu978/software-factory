// The suite's parallel rule (PBI 390): a scenario tagged @serial runs alone. The rule is src/bdd/parallel.ts's.
import { setParallelCanAssign } from "@cucumber/cucumber";
import { canAssign } from "../../src/bdd/parallel.ts";

setParallelCanAssign(canAssign);
