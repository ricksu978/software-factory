@pbi-20
Feature: Shadow risk classifier
  Every factory PR gets a risk tier, Low, Medium or High, with the reasons for it. In this phase the tier is
  only recorded, and a person still approves every PR. Some changes are never Low, whatever the classifier
  or the repo's risk.md says, because a wrong Low would one day let a change merge without anyone seeing it.

  Rule: A change to what steers the factory is at least Medium

    @ac-1
    Scenario Outline: A change to <file> is Medium even when the classifier and risk.md say Low
      Given the repo's risk.md says "Any change under .factory/ or .claude/ is Low"
      And the classifier answers "Low"
      When a PR that changes "<file>" is classified
      Then its tier is "Medium"
      And its reasons name "<file>"

      Examples:
        | file                            |
        | .factory/config.yml             |
        | .factory/dod.md                 |
        | .claude/agents/self-reviewer.md |
        | AGENTS.md                       |
        | src/CLAUDE.md                   |
        | .github/workflows/ci.yml        |

    @ac-1
    Scenario: A file under a sensitive path from the repo config is at least Medium
      Given the repo config lists "src/billing/**" as a sensitive path
      And the classifier answers "Low"
      When a PR that changes "src/billing/invoice.ts" is classified
      Then its tier is "Medium"

    @ac-1
    Scenario: A change to ordinary files keeps the classifier's Low
      Given the classifier answers "Low"
      When a PR that changes "docs/readme.md" is classified
      Then its tier is "Low"

    @ac-1
    Scenario: A classifier answer that can't be read makes the change High
      Given the classifier answers "I'm not sure"
      When a PR that changes "docs/readme.md" is classified
      Then its tier is "High"
      And its reasons include "classifier output unreadable"

  Rule: A Definition of Done line left for a person makes the change at least Medium

    @ac-2
    Scenario: A DoD line only a person can check raises a Low change to Medium
      Given the classifier answers "Low"
      And the DoD check left "Deployed to staging" for a person
      When a PR that changes "docs/readme.md" is classified
      Then its tier is "Medium"
      And its reasons include "a DoD line needs a person at merge: Deployed to staging"

    @ac-2
    Scenario: DoD lines the cell checked itself leave the tier alone
      Given the classifier answers "Low"
      And the DoD check passed "Tests pass"
      When a PR that changes "docs/readme.md" is classified
      Then its tier is "Low"

  Rule: The PR shows its tier and why

    @ac-3
    Scenario: The PR body carries the tier and its reasons
      Given the classifier answers "Low"
      When the cell opens the PR for an item whose change touches ".factory/config.yml"
      Then the PR body has a "Shadow risk tier" section saying "Medium"
      And that section lists the reason naming ".factory/config.yml"
