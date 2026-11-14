@pbi-249
Feature: A split child's body holds one acceptance criteria section, the parent's criteria word for word
  When the factory files a proposed split (PBI 144), it writes each child's body as the coding
  model's body, then the parent's criteria for that child, word for word, under the board's
  acceptance criteria heading. The coding model sometimes writes its own acceptance criteria into
  the child body, under that same heading and often reworded. The filed child then has two
  criteria sections, and the factory reads the model's section first, so the child goes into the
  factory with criteria the owner never wrote.
  With this item a filed child has one section under that heading, and it holds the parent's
  criteria the split gave that child, word for word. The factory drops any section the model
  wrote under that heading and keeps the rest of the model's body. The split request tells the
  model to leave acceptance criteria out of the body, because the factory adds them. A child body
  with no such section is filed as it is today.
  The board, the repo and the coding model are scripted here, so these scenarios need no model,
  no database and no network.

  Background:
    Given a repo "acme/shop" whose board's acceptance criteria heading is "Acceptance criteria"
    And a parent issue "Checkout redesign" in "acme/shop" on that board, carrying the opt-in label
    And the parent issue has these acceptance criteria:
      | index | text                                     |
      | 1     | A shopper can pay by card                |
      | 2     | A shopper can pay by bank transfer       |
      | 3     | A failed payment shows the reason        |
      | 4     | A receipt is emailed after every payment |
    And the readiness judge finds the parent issue oversized

  Rule: A filed child has one acceptance criteria section, holding the parent's criteria for that child word for word

    @ac-1
    Scenario: A child whose proposed body has its own reworded criteria is filed with only the parent's criteria
      Given the coding model proposes child "Card payments" taking criteria 1 and 3, with this body:
        """
        Card payments for Checkout redesign.

        ## Acceptance criteria

        - Card payment works
        - Errors are shown
        """
      And the coding model proposes child "Bank transfers" taking criteria 2 and 4, with a body that has no acceptance criteria section
      When the factory polls the backlog
      Then the body of child "Card payments" has exactly one section under the heading "Acceptance criteria"
      And child "Card payments" lists under its acceptance criteria heading, in order:
        | text                              |
        | A shopper can pay by card         |
        | A failed payment shows the reason |
      And the body of child "Card payments" doesn't contain "Card payment works"
      And the body of child "Card payments" doesn't contain "Errors are shown"

    @ac-1
    Scenario: The factory reads a filed child's criteria as the parent's criteria for that child, not the model's
      Given the coding model proposes child "Card payments" taking criteria 1 and 3, with this body:
        """
        Card payments for Checkout redesign.

        ## Acceptance criteria

        - Card payment works
        - Errors are shown
        - Saved cards can be reused
        """
      And the coding model proposes child "Bank transfers" taking criteria 2 and 4, with a body that has no acceptance criteria section
      When the factory polls the backlog
      Then the factory reads child "Card payments" as having these acceptance criteria, in order:
        | text                              |
        | A shopper can pay by card         |
        | A failed payment shows the reason |

    @ac-1
    Scenario: Every child of a split has one criteria section when the model wrote criteria into each body
      Given the coding model proposes child "Card payments" taking criteria 1 and 3, with a body that has its own section under "Acceptance criteria"
      And the coding model proposes child "Bank transfers" taking criteria 2 and 4, with a body that has its own section under "Acceptance criteria"
      When the factory polls the backlog
      Then the body of child "Card payments" has exactly one section under the heading "Acceptance criteria"
      And the body of child "Bank transfers" has exactly one section under the heading "Acceptance criteria"
      And child "Bank transfers" lists under its acceptance criteria heading, in order:
        | text                                     |
        | A shopper can pay by bank transfer       |
        | A receipt is emailed after every payment |

  Rule: The factory drops the model's own section under the criteria heading before filing, and keeps the rest of the body

    @ac-2
    Scenario: The text before and after the model's criteria section is kept in order
      Given the coding model proposes child "Card payments" taking criteria 1 and 3, with this body:
        """
        Card payments for Checkout redesign.

        ## Acceptance criteria

        - Card payment works

        ## Notes

        Implements spec §7.2.
        """
      And the coding model proposes child "Bank transfers" taking criteria 2 and 4, with a body that has no acceptance criteria section
      When the factory polls the backlog
      Then the body of child "Card payments" starts with "Card payments for Checkout redesign."
      And the body of child "Card payments" contains a section "Notes" reading "Implements spec §7.2."
      And in the body of child "Card payments", "Card payments for Checkout redesign." comes before the "Notes" section
      And the body of child "Card payments" doesn't contain "Card payment works"

    @ac-2
    Scenario: The model's section is dropped whatever its heading level
      Given the coding model proposes child "Card payments" taking criteria 1 and 3, with this body:
        """
        Card payments for Checkout redesign.

        ### Acceptance criteria

        - Card payment works
        """
      And the coding model proposes child "Bank transfers" taking criteria 2 and 4, with a body that has no acceptance criteria section
      When the factory polls the backlog
      Then the body of child "Card payments" has exactly one section under the heading "Acceptance criteria"
      And the body of child "Card payments" doesn't contain "Card payment works"
      And the body of child "Card payments" starts with "Card payments for Checkout redesign."

    @ac-2
    Scenario: The model's section is dropped whatever the letter case of its heading
      Given the coding model proposes child "Card payments" taking criteria 1 and 3, with this body:
        """
        Card payments for Checkout redesign.

        ## ACCEPTANCE CRITERIA

        - Card payment works
        """
      And the coding model proposes child "Bank transfers" taking criteria 2 and 4, with a body that has no acceptance criteria section
      When the factory polls the backlog
      Then the body of child "Card payments" has exactly one section under the heading "Acceptance criteria"
      And the body of child "Card payments" doesn't contain "Card payment works"

    @ac-2
    Scenario: Every section the model wrote under the heading is dropped when it wrote more than one
      Given the coding model proposes child "Card payments" taking criteria 1 and 3, with this body:
        """
        Card payments for Checkout redesign.

        ## Acceptance criteria

        - Card payment works

        ## Scope

        Cards only.

        ## Acceptance criteria

        - Errors are shown
        """
      And the coding model proposes child "Bank transfers" taking criteria 2 and 4, with a body that has no acceptance criteria section
      When the factory polls the backlog
      Then the body of child "Card payments" has exactly one section under the heading "Acceptance criteria"
      And the body of child "Card payments" contains a section "Scope" reading "Cards only."
      And the body of child "Card payments" doesn't contain "Card payment works"
      And the body of child "Card payments" doesn't contain "Errors are shown"

    @ac-2
    Scenario: A body that is nothing but a criteria section is still filed, with the parent's criteria
      Given the coding model proposes child "Card payments" taking criteria 1 and 3, with this body:
        """
        ## Acceptance criteria

        - Card payment works
        """
      And the coding model proposes child "Bank transfers" taking criteria 2 and 4, with a body that has no acceptance criteria section
      When the factory polls the backlog
      Then "acme/shop" holds a new issue titled "Card payments"
      And the body of child "Card payments" has exactly one section under the heading "Acceptance criteria"
      And the body of child "Card payments" doesn't contain "Card payment works"

  Rule: The split request tells the model to leave acceptance criteria out of each child's body, because the factory adds them

    @ac-3
    Scenario: The split request asks for child bodies without acceptance criteria
      When the factory builds the coding model's split request for the parent issue
      Then the request tells the model to leave acceptance criteria out of each child's body
      And the request says the factory adds each child's acceptance criteria itself

    @ac-3
    Scenario: The split request still asks for each child's criteria by index
      When the factory builds the coding model's split request for the parent issue
      Then the request tells the model to leave acceptance criteria out of each child's body
      And the request still asks for each child's "criteria" as the indices of the parent's criteria it takes

    @ac-3
    Scenario: A repo with its own dor.md still gets the instruction to leave criteria out of the body
      Given the parent issue's repo has a ".factory/dor.md" with the criterion "Names the screen it changes"
      When the factory builds the coding model's split request for the parent issue
      Then the request tells the model to leave acceptance criteria out of each child's body
      And the request lists the criterion "Names the screen it changes" word for word

  Rule: A child whose body has no section under the criteria heading is filed as today

    @ac-4 @regression
    Scenario: A child body without a criteria section is filed whole, with the parent's criteria after it
      Given the coding model proposes child "Card payments" taking criteria 1 and 3, with this body:
        """
        Card payments for Checkout redesign.

        ## Notes

        Implements spec §7.2.
        """
      And the coding model proposes child "Bank transfers" taking criteria 2 and 4, with a body that has no acceptance criteria section
      When the factory polls the backlog
      Then the body of child "Card payments" starts with "Card payments for Checkout redesign."
      And the body of child "Card payments" contains a section "Notes" reading "Implements spec §7.2."
      And child "Card payments" lists under its acceptance criteria heading, in order:
        | text                              |
        | A shopper can pay by card         |
        | A failed payment shows the reason |
      And the body of child "Card payments" ends by saying it was filed by the factory from the parent issue

    @ac-4 @regression
    Scenario: Children without criteria sections are filed, linked and placed as today
      Given the coding model proposes child "Card payments" taking criteria 1 and 3, with a body that has no acceptance criteria section
      And the coding model proposes child "Bank transfers" taking criteria 2 and 4, needing child 1, with a body that has no acceptance criteria section
      When the factory polls the backlog
      Then the parent issue has these sub-issues, in order:
        | title          |
        | Card payments  |
        | Bank transfers |
      And child "Bank transfers" is blocked by "Card payments" only
      And the factory reads child "Bank transfers" as having these acceptance criteria, in order:
        | text                                     |
        | A shopper can pay by bank transfer       |
        | A receipt is emailed after every payment |

    @ac-4 @regression
    Scenario: A body whose only near match is a different heading is filed whole
      Given the coding model proposes child "Card payments" taking criteria 1 and 3, with this body:
        """
        Card payments for Checkout redesign.

        ## Acceptance criteria notes

        Ask the payments team before changing these.
        """
      And the coding model proposes child "Bank transfers" taking criteria 2 and 4, with a body that has no acceptance criteria section
      When the factory polls the backlog
      Then the body of child "Card payments" contains a section "Acceptance criteria notes" reading "Ask the payments team before changing these."
      And the body of child "Card payments" has exactly one section under the heading "Acceptance criteria"
