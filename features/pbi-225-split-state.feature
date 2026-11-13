@pbi-225
Feature: A parent whose split is filed rests in a Split state of its own
  When the readiness gate finds an item oversized, the factory files the proposed split as child
  issues and takes the opt-in label off the parent (PBI 144). The parent is then NotReady without its
  label, so the next poll withdraws it to Abandoned, as it would any item a person pulled from the
  backlog (PBI 168). Abandoned says the work was dropped, which is wrong: the work went on in the
  children. An Abandoned parent that gets its label back also returns to Eligible, and a NotReady
  parent goes back to Eligible after a policy change, so a finished split can meet the gate again.
  With this item the parent moves from NotReady to a new state, Split, through the event
  "split_filed", once its last child is filed and its label is gone. A Split parent stays Split. Its
  label coming back doesn't move it, and neither does a change to the readiness policy.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run
  them. The board, the repo, the readiness judge and the coding model are fakes. The rest need no
  database.

  Background:
    Given a repo "acme/shop" whose board's backlog status is "Backlog" and whose opt-in label is "factory"
    And a parent issue "Checkout redesign" in "acme/shop" on that board, carrying the label "factory"
    And the readiness judge finds the parent issue oversized
    And the coding model proposes a split of the parent issue into "Card payments", "Bank transfers" and "Payment receipts"

  Rule: The state machine moves a NotReady item to Split on "split_filed"

    @ac-1
    Scenario: "split_filed" moves a NotReady item to Split
      Given an item in state "NotReady"
      When the event "split_filed" happens
      Then the item is in state "Split"

  Rule: Filing the last child and taking the parent's label off moves the parent from NotReady to Split, not to Abandoned

    @ac-1 @db
    Scenario: A parent whose children are all filed in one poll ends up Split, not Abandoned
      Given the factory has polled the backlog once
      And the parent issue has 3 sub-issues
      And the parent issue no longer carries the label "factory"
      When the factory polls the backlog again
      Then the factory holds the parent issue in state "Split"
      And the parent's history shows exactly one move "split_filed", from "NotReady" to "Split"
      And the parent's history shows no move to "Abandoned"

    @ac-1 @db
    Scenario: A Split parent never passes through Abandoned, however many polls follow
      Given the factory has polled the backlog once
      When the factory polls the backlog three more times
      Then the factory holds the parent issue in state "Split"
      And the parent's history shows no move "withdrawn"
      And the parent's history shows no move to "Abandoned"

    @ac-1 @db
    Scenario: A parent whose filing stopped partway is Split only after the poll that files its last child
      Given the repo refuses the next filing of child "Bank transfers" once
      And the factory has polled the backlog once
      When the factory polls the backlog twice more
      Then the parent issue has exactly 3 sub-issues
      And the parent issue no longer carries the label "factory"
      And the factory holds the parent issue in state "Split"
      And the parent's history shows exactly one move "split_filed", from "NotReady" to "Split"
      And the parent's history shows no move to "Abandoned"

    @ac-1 @db
    Scenario: A parent whose label came off only on a later poll is Split, not Abandoned
      Given the repo refuses to comment on the parent issue once
      And the factory has polled the backlog once
      When the factory polls the backlog twice more
      Then the parent issue no longer carries the label "factory"
      And the factory holds the parent issue in state "Split"
      And the parent's history shows no move to "Abandoned"

  Rule: A Split parent stays Split without its label, with its label back, and through a policy change

    @ac-2 @db
    Scenario: A Split parent without its label stays Split across later polls
      Given the factory has polled the backlog twice, filing every child and taking the parent's label off
      When the factory polls the backlog three more times
      Then the factory holds the parent issue in state "Split"
      And the parent's history shows exactly one move "split_filed"
      And the parent's history shows no move after "split_filed"

    @ac-2 @db
    Scenario: A Split parent whose label a person adds back stays Split and isn't gated again
      Given the factory has polled the backlog twice, filing every child and taking the parent's label off
      And the owner has put the label "factory" back on the parent issue
      When the factory polls the backlog twice more
      Then the factory holds the parent issue in state "Split"
      And the parent's history shows no move "returned"
      And the parent's history shows no move to "Eligible"
      And the readiness judge was not asked about the parent issue again
      And the parent issue has exactly 3 sub-issues

    @ac-2 @db
    Scenario Outline: A Split parent stays Split when <change>
      Given the factory has polled the backlog twice, filing every child and taking the parent's label off
      And <change>
      When the factory polls the backlog once more
      Then the factory holds the parent issue in state "Split"
      And the parent's history shows no move "policy_changed"
      And the parent's history shows no move to "Eligible"
      And the readiness judge was not asked about the parent issue again

      Examples:
        | change                                                            |
        | the factory restarts with a judge prompt that differs by one word |
        | the factory restarts with the readiness version raised by one     |
        | the repo's Definition of Ready changes                            |

    @ac-2 @db
    Scenario: A Split parent with its label back stays Split through a policy change
      Given the factory has polled the backlog twice, filing every child and taking the parent's label off
      And the owner has put the label "factory" back on the parent issue
      And the factory restarts with a judge prompt that differs by one word
      When the factory polls the backlog twice more
      Then the factory holds the parent issue in state "Split"
      And the parent's history shows no move "returned"
      And the parent's history shows no move "policy_changed"
      And the readiness judge was not asked about the parent issue again
