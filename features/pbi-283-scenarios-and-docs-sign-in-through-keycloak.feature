@pbi-283
Feature: Scenarios and docs sign in through Keycloak and use the split services
  Step 9 of the control plane redesign (2026-11-07 design, §11 and §12) retires today's dashboard: #281 deletes
  src/http/routes.ts, src/http/views.ts, the dev token, /dev-login and the combined src/main.ts. This item moves
  everything that still leans on them over to the split services. People sign in to the dashboard at a sign-in
  provider through the BFF: in the suite, the test sign-in provider the test starts, and under aspire run, Keycloak's
  "factory" realm, whose test owner is "owner". The scenarios look up the BFF, the API, the cell API and the worker in
  place of the single control resource, and the README tells the owner to sign in at Keycloak.
  "Signing in at the provider" means the browser starts at the BFF's /auth/login, signs in at the provider, and comes
  back to the BFF with a session cookie. "Uses the dev sign-in" means a step reads the dev token, opens /dev-login, or
  reads a sign-in link from a console.
  PBI 19's and PBI 89's feature files change, because their sign-in scenarios are rewritten for the provider. The
  feature files of the other step files this item moves stay as they are.
  scripts/factory.ps1, which the item names beside the README, was retired by PBI 208, so the README is where the
  owner reads how to sign in.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run them. The scenarios
  tagged @local need Docker, the Aspire CLI and the owner's secrets, or run scenarios the suite already runs, so the
  owner runs them and the PR records the run.

  Rule: PBI 19's and PBI 89's scenarios sign people in at the sign-in provider through the BFF

    @ac-1 @db
    Scenario Outline: PBI <pbi>'s scenario "<scenario>" signs in at the test sign-in provider, and passes
      When the owner runs PBI <pbi>'s scenario "<scenario>"
      Then the scenario passes
      And everyone it signed in signed in at the test sign-in provider through the BFF
      And it used no dev sign-in

      Examples:
        | pbi | scenario                                                                              |
        | 19  | Only allowlisted people get past sign-in                                              |
        | 19  | A dashboard POST from another origin gets 403 and changes nothing                     |
        | 19  | A dashboard POST from the dashboard's own origin goes through                         |
        | 19  | Floor shows what waits on the owner, oldest first                                     |
        | 19  | Floor shows the next five items the factory would take                                |
        | 19  | Floor shows each not-ready item with the lines it failed                              |
        | 19  | A product owner's /approve comment signs off exactly as the dashboard button does     |
        | 89  | An operator's hold from the dashboard takes effect on the scheduler's next tick       |
        | 89  | An override with an empty reason gets 400                                             |
        | 89  | Re-queue needs a reason, and moves a Failed item back to Queued                       |
        | 89  | Re-queue needs a reason, and moves a Abandoned item back to Queued                    |
        | 89  | Run detail shows each scenario's red and green verdicts and links each stage's transcript |
        | 89  | /phase0 shows an item that merged twice as two rows                                   |
        | 89  | Floor shows an in-flight item's last agent message, cut to 500 characters             |

    @ac-1 @db
    Scenario: A stranger who signs in at the provider is still refused in PBI 19's scenarios
      When the owner runs PBI 19's scenario "Only allowlisted people get past sign-in"
      Then its example for "stranger" signed "stranger" in at the test sign-in provider
      And that example saw "You don't have access to this factory. Ask an owner to add you."

    @ac-1 @db
    Scenario: PBI 19 still checks that Azure's sign-in headers alone sign nobody in
      When the owner runs PBI 19's scenario "A request with no session cookie gets no identity, even carrying every Azure sign-in header"
      Then the scenario passes
      And it used no dev sign-in

    @ac-1
    Scenario Outline: PBI <pbi>'s feature file says nothing of the dev sign-in
      When I read PBI <pbi>'s feature file
      Then no scenario in it mentions a sign-in link, a sign-in link's token, or a cookie a sign-in link sets
      And no scenario in it mentions FACTORY_DEV_LOGIN or the dev identity guard

      Examples:
        | pbi |
        | 19  |
        | 89  |

    @ac-1
    Scenario Outline: PBI <pbi>'s steps use no dev sign-in
      When I read PBI <pbi>'s step definitions
      Then they read no dev token and open no "/dev-login"
      And they look for no sign-in link in any output or console

      Examples:
        | pbi |
        | 19  |
        | 89  |

    @ac-1 @local @serial
    Scenario: Under aspire run, PBI 89's @local scenario signs the owner in at Keycloak
      Given the image "factory-cell:local" is built
      When the owner runs PBI 89's scenarios tagged @local
      Then every one of them passes
      And one of them signs in at Keycloak's "factory" realm as "owner" through the BFF, and opens Floor
      And none of them reads a sign-in link from a resource's console

  Rule: PBI 6's scenarios look up the split services, not the single control resource

    @ac-2
    Scenario: PBI 6's steps ask Aspire about no resource called control
      When I read PBI 6's step definitions
      Then they wait for, describe or read the logs of no resource named "control"
      And before a scenario goes on, they wait for the "bff", "api", "cell-api" and "worker" resources to be up

    @ac-2
    Scenario: PBI 6's steps call the probes on the service that serves them
      When I read PBI 6's step definitions
      Then every probe they call, "/probe/runs", "/probe/env" and "/probe/sas", goes to the "cell-api" resource's address

    @ac-2 @local @serial
    Scenario: Every scenario of PBI 6 passes against the split services
      When the owner runs every scenario of PBI 6
      Then every scenario passes
      And no scenario was skipped or left undefined
      And no step asked Aspire about a resource named "control"

  Rule: No step definition leans on the code #281 deletes, and the steps that did drive the BFF, the API or the worker

    @ac-3
    Scenario: No step definition imports, loads or starts the retired dashboard or the combined control plane
      When I read every step definition and support file under "features/"
      Then none imports or loads "src/http/routes.ts" or "src/http/views.ts"
      And none imports, loads or starts "src/main.ts"
      And none reads the dev token or opens "/dev-login"

    @ac-3
    Scenario Outline: PBI <pbi>'s steps drive the BFF, the API or the worker in place of <retired>
      When I read PBI <pbi>'s step definitions
      Then they import, load or start none of "src/http/routes.ts", "src/http/views.ts" or "src/main.ts"
      And they read no dev token and open no "/dev-login"
      And they drive the BFF, the API or the worker

      Examples:
        | pbi | retired            |
        | 105 | src/http/routes.ts |
        | 117 | src/http/routes.ts |
        | 131 | src/http/routes.ts |
        | 132 | src/http/routes.ts |
        | 146 | src/http/routes.ts |
        | 168 | src/http/routes.ts |
        | 173 | src/http/routes.ts |
        | 175 | src/http/routes.ts |
        | 187 | src/http/routes.ts |
        | 19  | src/http/routes.ts |
        | 190 | src/http/routes.ts |
        | 194 | src/http/routes.ts |
        | 209 | src/http/routes.ts |
        | 219 | src/http/routes.ts |
        | 227 | src/http/routes.ts |
        | 237 | src/http/routes.ts |
        | 156 | src/main.ts        |
        | 222 | src/main.ts        |
        | 300 | src/main.ts        |
        | 89  | src/main.ts        |

    @ac-3
    Scenario Outline: PBI <pbi>'s steps, which came to import src/http/routes.ts after the item was written, drive the API instead
      When I read PBI <pbi>'s step definitions
      Then they import, load or start none of "src/http/routes.ts", "src/http/views.ts" or "src/main.ts"
      And they drive the BFF, the API or the worker

      Examples:
        | pbi |
        | 364 |
        | 365 |
        | 395 |

    @ac-3 @regression
    Scenario Outline: PBI <pbi>'s feature file is unchanged
      Then the feature file of PBI <pbi> is the same as on main before this item

      Examples:
        | pbi |
        | 105 |
        | 117 |
        | 131 |
        | 132 |
        | 146 |
        | 168 |
        | 173 |
        | 175 |
        | 187 |
        | 190 |
        | 194 |
        | 209 |
        | 219 |
        | 227 |
        | 237 |
        | 156 |
        | 222 |
        | 300 |
        | 364 |
        | 365 |
        | 395 |

    @ac-3 @db @local @regression
    Scenario Outline: Every scenario of PBI <pbi> not tagged @local passes
      When the owner runs every scenario of PBI <pbi> not tagged @local
      Then every scenario passes
      And no scenario was skipped or left undefined

      Examples:
        | pbi |
        | 105 |
        | 117 |
        | 131 |
        | 132 |
        | 146 |
        | 168 |
        | 173 |
        | 175 |
        | 187 |
        | 19  |
        | 190 |
        | 194 |
        | 209 |
        | 219 |
        | 227 |
        | 237 |
        | 156 |
        | 222 |
        | 300 |
        | 89  |
        | 364 |
        | 365 |
        | 395 |

  Rule: The README tells the owner to sign in at Keycloak

    @ac-4
    Scenario: The README's "Sign in" section sends the owner to the dashboard and on to Keycloak
      When I read the "Sign in" section of "README.md"
      Then it tells the owner to open the factory dashboard at "http://localhost:7400"
      And it says the dashboard sends them to Keycloak to sign in
      And it names the realm's test owner, "owner", and where to find its password

    @ac-4
    Scenario: The README no longer sends the owner to the control console for a sign-in link
      When I read "README.md"
      Then it doesn't tell the owner to open the "control" resource's console
      And it mentions no sign-in link for this start
      And it doesn't say the local dashboard signs the owner in as the "dev-login" user
