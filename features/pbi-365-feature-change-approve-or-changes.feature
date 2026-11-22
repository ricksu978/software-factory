@pbi-365
Feature: The Product Owner approves or turns down a feature change request with /approve or /changes
  A stage that runs after sign-off can ask to change a locked feature file, and the item then waits in
  FeatureChangeRequest (PBI 364). Today nothing answers that request: a /approve or /changes comment
  only acts on scenarios waiting for sign-off, so the item waits for good. With this item, the Product
  Owner answers the request with the same two comments used at sign-off, and only the Product Owner
  may. /approve commits the proposed feature files to the item's branch, moves the lock to that
  commit, and resumes the item at the stage that asked. From then on every gate compares the feature
  files against the new lock. /changes <note> turns the request down: the lock stays where it was,
  and the item resumes at the stage that asked, with the note in that stage's findings.
  In each scenario, item 482's feature file "features/pbi-482-orders.feature" was locked at sign-off,
  and at the lock commit it holds the step "Then the order is refused". The green stage asked to change
  that step to "Then the order is held for review" because "An empty order is held, not refused", and
  item 482 waits in FeatureChangeRequest. "pia" is the Product Owner. The board, the repo and the
  agents are fakes.

  Rule: Only the Product Owner approves or turns down a feature change request

    @ac-1
    Scenario: The Product Owner's /approve applies to the request
      When "pia" comments "/approve" on item 482
      Then item 482 is no longer in FeatureChangeRequest
      And the feature change request on item 482 is recorded as approved by "pia"

    @ac-1
    Scenario Outline: A /approve from <who>, who isn't the Product Owner, changes nothing, and the Product Owner's later /approve still applies
      Given "<who>" is <role> who isn't the Product Owner
      When "<who>" comments "/approve" on item 482
      Then item 482 is still in FeatureChangeRequest
      And the lock of item 482 is still the sign-off commit
      And "<who>" gets a reply saying only the Product Owner can decide
      When "pia" comments "/approve" on item 482
      Then the lock of item 482 moves to a new commit
      And the feature change request on item 482 is recorded as approved by "pia"

      Examples:
        | who  | role        |
        | olga | an owner    |
        | otto | an operator |
        | vera | a viewer    |

    @ac-2
    Scenario: A /changes from someone who isn't the Product Owner changes nothing, and the Product Owner's later /changes still applies
      Given "otto" is an operator who isn't the Product Owner
      When "otto" comments "/changes Keep refusing empty orders" on item 482
      Then item 482 is still in FeatureChangeRequest
      And "otto" gets a reply saying only the Product Owner can decide
      When "pia" comments "/changes Empty orders stay refused" on item 482
      Then item 482 is no longer in FeatureChangeRequest
      And the feature change request on item 482 is recorded as turned down by "pia"
      And the green stage's findings hold the note "Empty orders stay refused"
      And the green stage's findings don't hold the note "Keep refusing empty orders"

    @ac-1
    Scenario: A /approve from someone with no account on the factory changes nothing, and the Product Owner's later /approve still applies
      Given "stranger" has no account on the factory
      When "stranger" comments "/approve" on item 482
      Then item 482 is still in FeatureChangeRequest
      When "pia" comments "/approve" on item 482
      Then the feature change request on item 482 is recorded as approved by "pia"

  Rule: /approve commits the proposed feature files to the branch and moves the lock to that commit

    @ac-1
    Scenario: The proposed version of the feature file is committed to the item's branch
      When "pia" comments "/approve" on item 482
      Then the item's branch has a new commit
      And at that commit "features/pbi-482-orders.feature" holds the step "Then the order is held for review"
      And at that commit "features/pbi-482-orders.feature" no longer holds the step "Then the order is refused"

    @ac-1
    Scenario: The lock moves to the commit that holds the proposed feature file
      When "pia" comments "/approve" on item 482
      Then the lock of item 482 is the new commit on the item's branch
      And "features/pbi-482-orders.feature" at the lock holds the step "Then the order is held for review"

    @ac-1
    Scenario: The commit goes on top of the stage's work already on the branch
      Given the green stage pushed its change to "src/orders.ts" before it asked
      When "pia" comments "/approve" on item 482
      Then the new commit's parent is the head of the branch the green stage pushed
      And the green stage's change to "src/orders.ts" is still on the item's branch

    @ac-1
    Scenario: A request for several feature files commits every proposed file in one commit
      Given item 482's feature files "features/pbi-482-orders.feature" and "features/pbi-482-refunds.feature" were locked at sign-off
      And the green stage asked to change both files
      When "pia" comments "/approve" on item 482
      Then the item's branch has exactly one new commit
      And at that commit both files hold the versions the green stage proposed
      And the lock of item 482 is that commit

    @ac-1
    Scenario: The same /approve handled twice commits the proposed files once
      When "pia" comments "/approve" on item 482
      And the factory handles that comment a second time
      Then the item's branch has exactly one new commit
      And the lock of item 482 is that commit

  Rule: /approve resumes the item at the stage that asked

    @ac-1
    Scenario Outline: An item whose <stage> stage asked resumes at <stage> after /approve
      Given the feature change request on item 482 was asked by the <stage> stage
      When "pia" comments "/approve" on item 482
      Then item 482's run resumes at <stage>

      Examples:
        | stage       |
        | red         |
        | green       |
        | self-review |
        | open-pr     |
        | address     |

  Rule: After /approve, later gates compare the feature files against the new lock

    @ac-1
    Scenario: The resumed stage keeps the approved feature file on the branch
      Given "pia" has commented "/approve" on item 482
      When the cell runs the green stage again and the green agent leaves "features/pbi-482-orders.feature" alone
      Then "features/pbi-482-orders.feature" on the pushed branch holds the step "Then the order is held for review"
      And the green stage doesn't restore "features/pbi-482-orders.feature"

    @ac-1
    Scenario: A later edit to the newly locked file is put back to the new lock, not the old one
      Given "pia" has commented "/approve" on item 482
      When the cell runs the green stage again and the green agent edits "features/pbi-482-orders.feature" without asking
      Then "features/pbi-482-orders.feature" on the pushed branch matches the new lock
      And "features/pbi-482-orders.feature" on the pushed branch holds the step "Then the order is held for review"

    @ac-1
    Scenario: The approved feature file reaches the pull request as the lock holds it
      Given "pia" has commented "/approve" on item 482
      When the factory takes item 482 through the rest of its run to its pull request
      Then the PR is opened
      And "features/pbi-482-orders.feature" in the PR holds the step "Then the order is held for review"
      And the owner is asked no question about a locked feature file

  Rule: /changes <note> turns the request down, keeps the lock, and resumes the stage that asked with the note in its findings

    @ac-2
    Scenario: /changes leaves the lock where it was and adds no commit
      When "pia" comments "/changes Empty orders stay refused" on item 482
      Then the feature change request on item 482 is recorded as turned down by "pia"
      And the lock of item 482 is still the sign-off commit
      And the item's branch has no new commit
      And "features/pbi-482-orders.feature" on the item's branch holds the step "Then the order is refused"

    @ac-2
    Scenario Outline: An item whose <stage> stage asked resumes at <stage> after /changes
      Given the feature change request on item 482 was asked by the <stage> stage
      When "pia" comments "/changes Empty orders stay refused" on item 482
      Then item 482's run resumes at <stage>
      And the <stage> stage's findings hold the note "Empty orders stay refused"

      Examples:
        | stage       |
        | red         |
        | green       |
        | self-review |
        | open-pr     |
        | address     |

    @ac-2
    Scenario: The resumed stage's agent is given the note
      Given "pia" has commented "/changes Empty orders stay refused" on item 482
      When the cell runs the green stage again
      Then the green agent's brief holds the note "Empty orders stay refused"

    @ac-2
    Scenario: A note over several lines reaches the findings whole
      When "pia" comments on item 482:
        """
        /changes Empty orders stay refused.
        Show the reason on the refusal.
        """
      Then the green stage's findings hold the note's lines "Empty orders stay refused." and "Show the reason on the refusal.", in that order

    @ac-2
    Scenario: After /changes, a later edit to the locked file is still put back to the sign-off lock
      Given "pia" has commented "/changes Empty orders stay refused" on item 482
      When the cell runs the green stage again and the green agent edits "features/pbi-482-orders.feature" without asking
      Then the green agent's brief holds the note "Empty orders stay refused"
      And "features/pbi-482-orders.feature" on the pushed branch matches the sign-off commit
      And "features/pbi-482-orders.feature" on the pushed branch holds the step "Then the order is refused"
