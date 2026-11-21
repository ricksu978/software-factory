// A cucumber-js plugin that `npm run bdd` loads (src/bdd/run.ts): it orders the scenarios with the @serial ones last,
// as src/bdd/parallel.ts explains.
import { serialLast } from "./parallel.ts";

type Pickles = readonly { pickle: { tags: readonly { name: string }[] } }[];
type Context = { transform: (event: "pickles:order", handler: (pickles: Pickles) => Pickles) => void };

export default {
  type: "plugin",
  coordinator: ({ transform }: Context) => {
    transform("pickles:order", serialLast);
  },
};
