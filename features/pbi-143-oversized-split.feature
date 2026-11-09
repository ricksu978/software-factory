@pbi-143
Feature: A PBI too big for one Sprint gets a proposed split from the factory
  The readiness judge already checks each item against the repo's dor.md and raises flags. With
  this item it also says whether the item is too big for one Sprint. Being too big never fails an
  item by itself. When the judge says an item is oversized, the factory asks the coding model to
  split it into 2 to 4 child items, checks that the split is sound, and posts it on the parent as a
  proposal for the team. A split that isn't sound is never posted; the readiness comment says why
  instead. The judge and the coding model are scripted here, so these scenarios need no model, no
  database and no network.

  Background:
    Given a repo whose ".factory/dor.md" holds the single line "Has a title"
    And a parent item "Checkout redesign" in that repo whose body cites spec section "§7.2"
    And the parent item has these acceptance criteria:
      | index | text                                         |
      | 1     | A shopper can pay by card                    |
      | 2     | A shopper can pay by bank transfer           |
      | 3     | A failed payment shows the reason            |
      | 4     | A receipt is emailed after every payment     |

  Rule: The judge reports whether an item is oversized beside its flags

    @ac-1
    Scenario: The judge is asked to put "oversized" on its last line beside "flags"
      When the factory builds the readiness judge's instructions for the parent item
      Then the instructions ask for a last line that carries both "flags" and "oversized"
      And the instructions say "oversized" is true or false

    @ac-1
    Scenario: A last line with "oversized": true reads as oversized
      Given a judge that passes every line, raises no flag and reports oversized true
      When the readiness gate checks the parent item
      Then the gate reads the parent item as oversized

    @ac-1
    Scenario: A last line with "oversized": false reads as not oversized
      Given a judge that passes every line, raises no flag and reports oversized false
      When the readiness gate checks the parent item
      Then the gate reads the parent item as not oversized
      And the coding model is not asked for a split

    @ac-1
    Scenario: A last line without "oversized" reads as not oversized
      Given a judge that passes every line and answers only '{"flags":[]}' on its last line
      When the readiness gate checks the parent item
      Then the gate reads the parent item as not oversized
      And the coding model is not asked for a split

    @ac-1
    Scenario: A last line whose "oversized" isn't true or false reads as not oversized
      Given a judge that passes every line and answers '{"flags":[],"oversized":"yes"}' on its last line
      When the readiness gate checks the parent item
      Then the gate reads the parent item as not oversized
      And the coding model is not asked for a split

  Rule: Being oversized never decides readiness on its own

    @ac-2
    Scenario: An oversized item that passes every check is ready
      Given a judge that passes every line, raises no flag and reports oversized true
      And a coding model that proposes a valid split
      When the readiness gate checks the parent item
      Then the parent item is ready
      And no readiness check in the results mentions the item's size
      And the gate reads the parent item as oversized

    @ac-2
    Scenario: An oversized item that fails a dor.md line is not ready, for that line only
      Given a judge that fails line 1 because "No title", raises no flag and reports oversized true
      And a coding model that proposes a valid split
      When the readiness gate checks the parent item
      Then the parent item is not ready
      And the only failed readiness check is "Has a title"
      And the gate reads the parent item as oversized

    @ac-2
    Scenario: An oversized item with a flag is not ready, for the flag only
      Given a judge that passes every line, flags "asks for credentials" and reports oversized true
      And a coding model that proposes a valid split
      When the readiness gate checks the parent item
      Then the parent item is not ready
      And the only failed readiness check is the flag "asks for credentials"
      And the gate reads the parent item as oversized

    @ac-2
    Scenario: An oversized item whose split is invalid is still ready when every check passes
      Given a judge that passes every line, raises no flag and reports oversized true
      And a coding model that proposes a split which leaves criterion 4 to no child
      When the readiness gate checks the parent item
      Then the parent item is ready
      And the gate reads the parent item as oversized

  Rule: An oversized item gets a split of 2 to 4 children from the coding model

    @ac-3
    Scenario: The coding model is asked to split an oversized item
      Given a judge that passes every line, raises no flag and reports oversized true
      And a coding model that proposes a valid split
      When the readiness gate checks the parent item
      Then the coding model is asked once for a split of the parent item
      And the request asks for 2 to 4 child items
      And the request asks each child for a title, a body naming "Checkout redesign" and spec section "§7.2", and the indices of the parent's criteria it takes
      And the request asks each child to name which earlier children it needs

    @ac-3
    Scenario: The request uses the SOP's coding model, not the triage model
      Given an SOP whose coding model is "model-c" and whose triage model is "model-t"
      And a judge that passes every line, raises no flag and reports oversized true
      And a coding model that proposes a valid split
      When the readiness gate checks the parent item
      Then the split is asked of "model-c"

    @ac-3 @ac-6
    Scenario Outline: A split with <count> children is invalid
      Given a judge that passes every line, raises no flag and reports oversized true
      And a coding model that proposes a split of <count> children that otherwise covers every criterion once
      When the readiness gate checks the parent item
      Then the parent item has no split proposal comment
      And the readiness result says a split couldn't be proposed because it must have 2 to 4 children

      Examples:
        | count |
        | 1     |
        | 5     |

    @ac-3 @ac-6
    Scenario: A split with a child that has no title is invalid
      Given a judge that passes every line, raises no flag and reports oversized true
      And a coding model that proposes a split whose second child has no title
      When the readiness gate checks the parent item
      Then the parent item has no split proposal comment
      And the readiness result says a split couldn't be proposed because child 2 has no title

  Rule: A split is valid only when every criterion goes to exactly one child and each child names the earlier children it needs

    @ac-4
    Scenario: A split that gives every criterion to exactly one child is valid
      Given a judge that passes every line, raises no flag and reports oversized true
      And a coding model that proposes this split:
        | child | title             | criteria | needs |
        | 1     | Card payments     | 1, 3     |       |
        | 2     | Bank transfers    | 2        | 1     |
        | 3     | Payment receipts  | 4        | 1, 2  |
      When the readiness gate checks the parent item
      Then the parent item has one split proposal comment

    @ac-4 @ac-6
    Scenario: A split that leaves a criterion to no child is invalid
      Given a judge that passes every line, raises no flag and reports oversized true
      And a coding model that proposes this split:
        | child | title             | criteria | needs |
        | 1     | Card payments     | 1, 3     |       |
        | 2     | Bank transfers    | 2        | 1     |
      When the readiness gate checks the parent item
      Then the parent item has no split proposal comment
      And the readiness result says a split couldn't be proposed because criterion 4 goes to no child

    @ac-4 @ac-6
    Scenario: A split that gives a criterion to two children is invalid
      Given a judge that passes every line, raises no flag and reports oversized true
      And a coding model that proposes this split:
        | child | title             | criteria | needs |
        | 1     | Card payments     | 1, 3     |       |
        | 2     | Bank transfers    | 2, 3     | 1     |
        | 3     | Payment receipts  | 4        | 1     |
      When the readiness gate checks the parent item
      Then the parent item has no split proposal comment
      And the readiness result says a split couldn't be proposed because criterion 3 goes to more than one child

    @ac-4 @ac-6
    Scenario: A split that gives a child a criterion the parent doesn't have is invalid
      Given a judge that passes every line, raises no flag and reports oversized true
      And a coding model that proposes this split:
        | child | title             | criteria | needs |
        | 1     | Card payments     | 1, 3     |       |
        | 2     | Bank transfers    | 2, 5     | 1     |
        | 3     | Payment receipts  | 4        | 1     |
      When the readiness gate checks the parent item
      Then the parent item has no split proposal comment
      And the readiness result says a split couldn't be proposed because the parent has no criterion 5

    @ac-4 @ac-6
    Scenario Outline: A split whose child needs <what> is invalid
      Given a judge that passes every line, raises no flag and reports oversized true
      And a coding model that proposes this split:
        | child | title             | criteria | needs        |
        | 1     | Card payments     | 1, 3     |              |
        | 2     | Bank transfers    | 2        | <needs of 2> |
        | 3     | Payment receipts  | 4        | 1            |
      When the readiness gate checks the parent item
      Then the parent item has no split proposal comment
      And the readiness result says a split couldn't be proposed because <reason>

      Examples:
        | what              | needs of 2 | reason                                      |
        | a later child     | 3          | child 2 needs child 3, which comes after it |
        | itself            | 2          | child 2 needs itself                        |
        | a missing child   | 7          | child 2 needs child 7, which doesn't exist  |

    @ac-4 @ac-6
    Scenario: A split whose child doesn't say what it needs is invalid
      Given a judge that passes every line, raises no flag and reports oversized true
      And a coding model that proposes a valid split except that child 2 gives no list of what it needs
      When the readiness gate checks the parent item
      Then the parent item has no split proposal comment
      And the readiness result says a split couldn't be proposed because child 2 doesn't say which earlier children it needs

  Rule: A valid split is posted on the parent as one comment, once for unchanged item text

    @ac-5
    Scenario: The proposal lists each child's title, its criteria word for word and what it needs
      Given a judge that passes every line, raises no flag and reports oversized true
      And a coding model that proposes this split:
        | child | title             | criteria | needs |
        | 1     | Card payments     | 1, 3     |       |
        | 2     | Bank transfers    | 2        | 1     |
        | 3     | Payment receipts  | 4        | 1, 2  |
      When the readiness gate checks the parent item
      Then the parent item has one split proposal comment
      And the proposal lists child "Card payments" with criteria "A shopper can pay by card" and "A failed payment shows the reason", needing nothing
      And the proposal lists child "Bank transfers" with criterion "A shopper can pay by bank transfer", needing "Card payments"
      And the proposal lists child "Payment receipts" with criterion "A receipt is emailed after every payment", needing "Card payments" and "Bank transfers"

    @ac-5
    Scenario: A not-ready oversized item gets its readiness comment and the proposal as separate comments
      Given a judge that fails line 1 because "No title", raises no flag and reports oversized true
      And a coding model that proposes a valid split
      When the readiness gate checks the parent item
      Then the parent item has one readiness comment
      And the parent item has one split proposal comment

    @ac-5
    Scenario: Gating the same item text again posts no second proposal
      Given a judge that passes every line, raises no flag and reports oversized true
      And a coding model that proposes a valid split
      And the readiness gate has checked the parent item once
      When the readiness gate checks the parent item again with its text unchanged
      Then the parent item has one split proposal comment

    @ac-5
    Scenario: Gating the same item text again after a policy change posts no second proposal
      Given a judge that passes every line, raises no flag and reports oversized true
      And a coding model that proposes a valid split
      And the readiness gate has checked the parent item once
      And the repo's dor.md has since changed
      When the readiness gate checks the parent item again with its text unchanged
      Then the parent item has one split proposal comment

    @ac-5
    Scenario: Gating the item again after its text changed posts a fresh proposal
      Given a judge that passes every line, raises no flag and reports oversized true
      And a coding model that proposes a valid split
      And the readiness gate has checked the parent item once
      And the parent item's body has since changed
      When the readiness gate checks the parent item again
      Then the parent item has two split proposal comments

    @ac-5
    Scenario: An item that isn't oversized gets no proposal
      Given a judge that passes every line, raises no flag and reports oversized false
      When the readiness gate checks the parent item
      Then the gate reads the parent item as not oversized
      And the parent item has no split proposal comment

  Rule: An invalid split posts no proposal, and the readiness comment says why

    @ac-6
    Scenario: A not-ready item with an invalid split says in its readiness comment why no split was proposed
      Given a judge that fails line 1 because "No title", raises no flag and reports oversized true
      And a coding model that proposes a split which leaves criterion 4 to no child
      When the readiness gate checks the parent item
      Then the parent item has no split proposal comment
      And the parent item has one readiness comment
      And the readiness comment quotes "Has a title" word for word
      And the readiness comment says a split couldn't be proposed because criterion 4 goes to no child

    @ac-6
    Scenario: A coding model reply that isn't a split at all posts no proposal
      Given a judge that fails line 1 because "No title", raises no flag and reports oversized true
      And a coding model that answers "I can't split this item"
      When the readiness gate checks the parent item
      Then the parent item has no split proposal comment
      And the readiness comment says a split couldn't be proposed because the coding model's reply couldn't be read

    @ac-6
    Scenario: A coding model that fails to answer posts no proposal
      Given a judge that fails line 1 because "No title", raises no flag and reports oversized true
      And a coding model whose run fails
      When the readiness gate checks the parent item
      Then the parent item has no split proposal comment
      And the readiness comment says a split couldn't be proposed because the coding model gave no answer

    @ac-6
    Scenario: The readiness comment says nothing about a split when the split was valid
      Given a judge that fails line 1 because "No title", raises no flag and reports oversized true
      And a coding model that proposes a valid split
      When the readiness gate checks the parent item
      Then the parent item has one split proposal comment
      And the readiness comment doesn't say a split couldn't be proposed
