@pbi-294
Feature: The spec and the Phase 0 plan keep one sentence per line, so PRs that change different sentences don't conflict
  Many PRs edit the design spec and the Phase 0 plan at the same time. Today a paragraph, or a table
  cell in the spec, sits on one long line. Two PRs that change different sentences in it change the
  same line, so git reports a conflict.
  With this item each sentence starts on its own line, and so does each table cell in the spec.
  Git then sees edits to different sentences as edits to different lines.
  HTML and Markdown join the lines of a paragraph, so a rendered page looks the same as before.
  The prose lint keeps it that way, for those two files only.
  Two TypeScript lists that PRs often extend together also put one entry per line.

  "The spec" is docs/superpowers/specs/2026-11-05-software-factory-design.html.
  "The plan" is docs/superpowers/plans/2026-11-05-phase-0-walking-skeleton.md.
  "Before this item" means commit 3df4f2e, the base of this item's branch.

  Rule: Each sentence in the spec and the plan starts on its own line, and so does each table cell in the spec

    @ac-1
    Scenario: No line of the spec's prose holds more than one sentence
      When I read the spec
      Then no line outside code holds more than one sentence
      And its text reads the same in a browser as it did before this item

    @ac-1
    Scenario: No line of the plan's prose holds more than one sentence
      When I read the plan
      Then no line outside code blocks holds more than one sentence
      And its rendered text reads the same as it did before this item

    @ac-1
    Scenario: Each table cell in the spec starts on its own line
      When I read the spec's tables
      Then every table cell starts on a line of its own
      And no line holds the end of one table cell and the start of the next
      And the tables read the same in a browser as they did before this item

    @ac-1
    Scenario: The spec and the plan keep every sentence they had
      When I read the spec and the plan
      Then no line outside code holds more than one sentence
      And every sentence in each file before this item is still in it, word for word

    @ac-1
    Scenario: Code in the plan keeps its line breaks
      When I read the plan
      Then no line outside code blocks holds more than one sentence
      And every code block in it is the same, line for line, as before this item

  Rule: The prose lint fails a line in the spec or the plan that holds more than one sentence, and names the file and line

    @ac-2
    Scenario: The lint fails a spec line with two sentences and names it
      Given a copy of the repo where line 200 of the spec holds "The cell opens the PR. Then CI runs."
      When I run the prose lint on the copy
      Then the lint fails
      And it reports line 200 of the spec as holding more than one sentence

    @ac-2
    Scenario: The lint fails a plan line with two sentences and names it
      Given a copy of the repo where line 10 of the plan holds "Leases renew every 60 seconds. They expire after 5 missed renewals."
      When I run the prose lint on the copy
      Then the lint fails
      And it reports line 10 of the plan as holding more than one sentence

    @ac-2
    Scenario: The lint fails a spec line that holds two table cells
      Given a copy of the repo where line 200 of the spec holds "<td>PBI</td><td>One work item.</td>"
      When I run the prose lint on the copy
      Then the lint fails
      And it reports line 200 of the spec

    @ac-2
    Scenario: The lint names every failing line, not just the first
      Given a copy of the repo where line 10 of the plan holds "Poll every 5 minutes. Renew every 60 seconds."
      And line 20 of the plan holds "Cells run in Docker. They never get pushed."
      When I run the prose lint on the copy
      Then the lint fails
      And it reports line 10 of the plan
      And it reports line 20 of the plan

    @ac-2
    Scenario: The lint passes the spec and the plan as this item leaves them
      When I run the prose lint on the repo
      Then the lint passes
      And a copy of the repo with "The cell opens the PR. Then CI runs." added to the plan fails the lint

    @ac-2
    Scenario Outline: A dot inside a sentence doesn't count as the end of one
      Given a copy of the repo where line 10 of the plan holds "<line>"
      When I run the prose lint on the copy
      Then the lint passes
      And a copy of the repo with "<line> Then CI runs." at line 10 of the plan fails the lint

      Examples:
        | line                                                          |
        | Node 26.13.0 runs the control plane at 0.5 vCPU.              |
        | The poller reads `.factory/dod.md` before it runs.            |
        | §13's Phase 0 row is the scope.                               |

    @ac-2
    Scenario: The lint ignores sentences inside a code block in the plan
      Given a copy of the repo where a code block in the plan holds the line "// Start the cell. Then wait."
      And line 10 of the plan holds "The cell opens the PR. Then CI runs."
      When I run the prose lint on the copy
      Then the lint fails
      And it reports line 10 of the plan
      And it doesn't report the line inside the code block

    @ac-2
    Scenario Outline: The lint doesn't apply the rule to any other document
      Given a copy of the repo where "<other>" holds the line "The cell opens the PR. Then CI runs."
      And line 10 of the plan holds "Leases renew every 60 seconds. They expire after 5 missed renewals."
      When I run the prose lint on the copy
      Then the lint fails
      And it reports line 10 of the plan
      And it reports no line of "<other>" as holding more than one sentence

      Examples:
        | other                                                         |
        | README.md                                                     |
        | docs/superpowers/specs/2026-11-07-control-plane-redesign.html |
        | docs/superpowers/spikes/2026-11-phase-0-platform.md           |

  Rule: With the new layout, replaying past merges conflicts in far fewer files

    @ac-3
    Scenario: Replaying the 47 file merges in the item's Notes gives at most 19 conflicts
      Given the merges listed in the item's Notes, 47 file merges in all
      When I replay each merge with both sides in the new one-sentence-per-line layout
      Then at most 19 of the 47 file merges conflict

    @ac-3
    Scenario: The PR states the conflict count the replay got
      Given the merges listed in the item's Notes have been replayed with the new layout
      When I read the description of this item's PR
      Then it states how many of the 47 file merges conflicted
      And that count is the one the replay got

  Rule: Two lists that PRs often extend together put one entry per line

    @ac-4
    Scenario: The fake repo host's state list puts one entry per line
      When I read the list of state that `fakeRepoHost` in "src/adapters/fake.ts" returns
      Then each entry sits on a line of its own
      And the list holds the same entries as before this item

    @ac-4
    Scenario: The Floor page's parameter type puts one entry per line
      When I read the parameter type of the Floor page in "src/http/views.ts"
      Then each entry sits on a line of its own
      And the type holds the same entries, with the same types, as before this item
