@pbi-202
Feature: Split children are written against dor.md and cite every spec section they change
  When the readiness judge finds an item too big for one Sprint, the factory asks the coding model
  to split it into 2 to 4 children (PBI 143) and files them for the owner (PBI 144). The judge
  checks every item against the repo's dor.md, or the factory's default when the repo has none,
  but the coding model never sees that file. So children come back that fail the very checks
  they'll face once the owner opts them in. The request also asks each child to name only the spec
  section or plan task the parent cites, so a child that changes another section doesn't say so.
  With this item the split request carries the same dor.md the judge reads and asks for child
  bodies that meet it, and asks each child to cite every spec section or plan task that child
  itself implements or changes. A change to dor.md still never files a second set of children for
  a parent whose split was already filed. The board, the repo, the readiness judge and the coding
  model are scripted here, so these scenarios need no model, no database and no network.

  Background:
    Given a parent item "Checkout redesign" whose body cites spec section "§7.2"
    And the parent item has these acceptance criteria:
      | index | text                                     |
      | 1     | A shopper can pay by card                |
      | 2     | A shopper can pay by bank transfer       |
      | 3     | A failed payment shows the reason        |
      | 4     | A receipt is emailed after every payment |
    And the readiness judge finds the parent item oversized
    And the coding model proposes a valid split of the parent item

  Rule: The split request carries the repo's dor.md, the same file the judge reads, and asks for children that meet it

    @ac-1
    Scenario: The split request lists each of the repo's dor.md criteria word for word
      Given the parent item's repo has a ".factory/dor.md" with these criteria:
        | text                                     |
        | Names the screen it changes              |
        | Says which payment provider it uses      |
      When the readiness gate checks the parent item
      Then the coding model is asked once for a split of the parent item
      And the split request lists the criterion "Names the screen it changes" word for word
      And the split request lists the criterion "Says which payment provider it uses" word for word

    @ac-1
    Scenario: The split request carries the same dor.md criteria the judge was given for the item
      Given the parent item's repo has a ".factory/dor.md" with these criteria:
        | text                                     |
        | Names the screen it changes              |
        | Says which payment provider it uses      |
      When the readiness gate checks the parent item
      Then every criterion the readiness judge was given for the parent item is in the split request
      And the split request lists no dor.md criterion the readiness judge wasn't given

    @ac-1
    Scenario: The split request carries the guidance written around the repo's dor.md criteria
      Given the parent item's repo has a ".factory/dor.md" whose text above its criteria reads "A ticket names its owner team."
      And that dor.md has the criterion "Names the screen it changes"
      When the readiness gate checks the parent item
      Then the split request includes "A ticket names its owner team." word for word
      And the split request lists the criterion "Names the screen it changes" word for word

    @ac-1
    Scenario: The split request asks for child bodies that meet the dor.md criteria
      Given the parent item's repo has a ".factory/dor.md" with the criterion "Names the screen it changes"
      When the readiness gate checks the parent item
      Then the split request asks for each child's body to meet every dor.md criterion it lists

    @ac-1
    Scenario: A repo's own dor.md replaces the factory default in the split request
      Given the parent item's repo has a ".factory/dor.md" with the criterion "Names the screen it changes"
      When the readiness gate checks the parent item
      Then the split request lists the criterion "Names the screen it changes" word for word
      And the split request lists none of the factory default dor.md's criteria

    @ac-1
    Scenario: A new dor.md shows in the split request for an item split after the change
      Given the parent item's repo has a ".factory/dor.md" with the criterion "Names the screen it changes"
      And the repo's dor.md has since changed to the single criterion "Links the design mock-up"
      When the readiness gate checks the parent item for the first time
      Then the split request lists the criterion "Links the design mock-up" word for word
      And the split request doesn't list "Names the screen it changes"

    @ac-1
    Scenario: The dor.md criteria in the split request don't change how a split is checked
      Given the parent item's repo has a ".factory/dor.md" with the criterion "Names the screen it changes"
      And the coding model proposes a split which leaves criterion 4 to no child
      When the readiness gate checks the parent item
      Then the split request lists the criterion "Names the screen it changes" word for word
      And the parent item has no split proposal comment
      And the readiness result says a split couldn't be proposed because criterion 4 goes to no child

  Rule: Each child cites every spec section or plan task it implements or changes, not only the parent's

    @ac-2
    Scenario: The split request asks each child to cite the spec sections and plan tasks it implements or changes
      When the factory builds the coding model's split request for the parent item
      Then the request asks each child's body to cite every spec section or plan task that child itself implements or changes
      And the request still asks each child's body to name the parent item "Checkout redesign"

    @ac-2
    Scenario: The split request doesn't limit a child's citations to the ones the parent cites
      When the factory builds the coding model's split request for the parent item
      Then the request says a child cites the sections and tasks it implements or changes even when the parent's body doesn't cite them
      And the request doesn't ask a child to cite only the spec section or plan task the parent's body cites

    @ac-2
    Scenario: A parent that cites no spec section still gets children asked to cite their own
      Given the parent item's body cites no spec section or plan task
      When the factory builds the coding model's split request for the parent item
      Then the request asks each child's body to cite every spec section or plan task that child itself implements or changes

  Rule: A change to dor.md never files a second set of children for a parent already split

    @ac-3 @regression
    Scenario: A dor.md change after a parent's children were filed files no second set
      Given the parent item is an issue in "acme/shop" carrying the opt-in label "factory"
      And the factory has polled the backlog once and filed the parent's 3 children
      And the repo's dor.md has since changed
      And the owner has put the label "factory" back on the parent issue
      When the factory polls the backlog again
      Then the parent issue has exactly 3 sub-issues
      And "acme/shop" holds exactly 3 new issues
      And the parent issue has one comment linking to its children

    @ac-3 @regression
    Scenario: A dor.md change while filing was stopped partway finishes the same children
      Given the parent item is an issue in "acme/shop" carrying the opt-in label "factory"
      And the repo refuses the next filing of the parent's second child once
      And the factory has polled the backlog once
      And the repo's dor.md has since changed
      When the factory polls the backlog again
      Then the coding model was asked for a split of the parent item only once
      And the parent issue has exactly 3 sub-issues
      And "acme/shop" holds exactly 3 new issues
      And no child of the parent was filed twice

    @ac-3 @regression
    Scenario: A dor.md change and a restart after the children were filed file no second set
      Given the parent item is an issue in "acme/shop" carrying the opt-in label "factory"
      And the factory has polled the backlog once and filed the parent's 3 children
      And the repo's dor.md has since changed
      And the factory has restarted
      And the owner has put the label "factory" back on the parent issue
      When the factory polls the backlog again
      Then the parent issue has exactly 3 sub-issues
      And "acme/shop" holds exactly 3 new issues

  Rule: A repo with no dor.md of its own gets the factory default in the split request, as the judge does

    @ac-4
    Scenario: A repo without a dor.md gets every factory default criterion in the split request
      Given the parent item's repo has no ".factory/dor.md"
      When the readiness gate checks the parent item
      Then the split request lists every criterion of the factory default dor.md word for word

    @ac-4
    Scenario: A repo without a dor.md gives the split request the same default criteria the judge was given
      Given the parent item's repo has no ".factory/dor.md"
      When the readiness gate checks the parent item
      Then every criterion the readiness judge was given for the parent item is in the split request
      And the split request lists no dor.md criterion the readiness judge wasn't given

    @ac-4
    Scenario: A repo whose dor.md has no criteria gets its own file in the split request, not the default, as the judge does
      Given the parent item's repo has a ".factory/dor.md" that reads "We have no readiness rules yet." and has no criteria
      When the readiness gate checks the parent item
      Then the split request includes "We have no readiness rules yet." word for word
      And the split request lists none of the factory default dor.md's criteria
