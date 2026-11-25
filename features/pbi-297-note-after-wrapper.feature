@pbi-297
Feature: A note with a code block after the PR body's wrapper stays out of the PR body
  Open-pr cleans the agent's reply before it writes the PR body (PBI 216). Since PBI 291, a reply
  that wraps the body in a "markdown", "md" or bare fenced block runs that wrapper to the reply's
  last line that holds only a fence, so code blocks inside the body are kept. But when the agent adds
  a note after the wrapper, and that note holds a code block of its own, the note's closing fence is
  the reply's last fence line. So the wrapper's closing fence, the note and the note's code block all
  land in the PR body.
  With this item, the wrapper closes at the first line that holds only a fence and leaves no code
  block inside the wrapper open. Everything after that line is left out of the body. A wrapped body
  with its own code blocks inside still reaches the PR whole, as PBI 291 made it.
  The scenarios run against a fake control plane, a fake agent and a fake repo host, so cells run
  them all. The "summary" is the agent's reply to open-pr. The "summary part" of the PR body is what
  comes before the factory's own "Refs #482" line.

  Background:
    Given a run for item 482 that resumes at open-pr
    And CI passes on every commit

  Rule: The wrapper closes at the first fence-only line that leaves no code block inside it open, and what follows is left out

    @ac-1
    Scenario: A "markdown" wrapper followed by a note with a bare code block gives only the wrapped body
      Given the open-pr agent replies with this summary:
        """
        ```markdown
        ## Problem

        Orders over 100 items time out.

        ## What changes

        Orders are saved in batches.
        ```

        To check it yourself, run:

        ```
        npm test
        ```
        """
      When the cell runs
      Then the summary part of the PR body is:
        """
        ## Problem

        Orders over 100 items time out.

        ## What changes

        Orders are saved in batches.
        """
      And the PR body doesn't hold "To check it yourself, run:"
      And the PR body doesn't hold "npm test"
      And the PR body doesn't hold "```"
      And the open-pr stage ran 1 attempt
      And the open-pr stage passed

    @ac-1
    Scenario: An "md" wrapper followed by a note with a bare code block gives only the wrapped body
      Given the open-pr agent replies with this summary:
        """
        ```md
        ## Problem

        The import fails on empty rows.
        ```

        I tested it with:

        ```
        npm run import -- empty.csv
        ```
        """
      When the cell runs
      Then the summary part of the PR body is:
        """
        ## Problem

        The import fails on empty rows.
        """
      And the PR body doesn't hold "I tested it with:"
      And the PR body doesn't hold "npm run import -- empty.csv"
      And the PR body doesn't hold "```"

    @ac-1
    Scenario: A bare wrapper followed by a note with a bare code block gives only the wrapped body
      Given the open-pr agent replies with this summary:
        """
        Sure.

        ```
        ## Problem

        The build skips the lint step.
        ```

        You can confirm with:

        ```
        npm run lint
        ```
        """
      When the cell runs
      Then the summary part of the PR body is:
        """
        ## Problem

        The build skips the lint step.
        """
      And the PR body doesn't hold "Sure."
      And the PR body doesn't hold "You can confirm with:"
      And the PR body doesn't hold "npm run lint"
      And the PR body doesn't hold "```"

    @ac-1
    Scenario: A note whose code block names a language is left out too
      Given the open-pr agent replies with this summary:
        """
        ```markdown
        ## Problem

        Totals ignore VAT.
        ```

        Run this to see the new totals:

        ```sh
        npm run totals
        ```
        """
      When the cell runs
      Then the summary part of the PR body is:
        """
        ## Problem

        Totals ignore VAT.
        """
      And the PR body doesn't hold "Run this to see the new totals:"
      And the PR body doesn't hold "npm run totals"
      And the PR body doesn't hold "```"

    @ac-1
    Scenario: A code block inside the wrapper is kept, and the note's code block after the wrapper is not
      Given the open-pr agent replies with this summary:
        """
        Here is the PR body you asked for:

        ```markdown
        ## Problem

        Orders over 100 items time out.

        ## What changes

        Orders are saved in batches:

        ```ts
        await saveInBatches(order, 50);
        ```
        ```

        To check it yourself, run:

        ```
        npm test
        ```
        """
      When the cell runs
      Then the summary part of the PR body is:
        """
        ## Problem

        Orders over 100 items time out.

        ## What changes

        Orders are saved in batches:

        ```ts
        await saveInBatches(order, 50);
        ```
        """
      And the PR body doesn't hold "Here is the PR body you asked for:"
      And the PR body doesn't hold "To check it yourself, run:"
      And the PR body doesn't hold "npm test"
      And the open-pr stage ran 1 attempt
      And the open-pr stage passed

    @ac-1
    Scenario: Several notes and code blocks after the wrapper are all left out
      Given the open-pr agent replies with this summary:
        """
        ```markdown
        ## Problem

        The import fails on empty rows.
        ```

        First run:

        ```
        npm ci
        ```

        Then run:

        ```
        npm run import -- empty.csv
        ```

        Let me know if you want any changes.
        """
      When the cell runs
      Then the summary part of the PR body is:
        """
        ## Problem

        The import fails on empty rows.
        """
      And the PR body doesn't hold "First run:"
      And the PR body doesn't hold "npm ci"
      And the PR body doesn't hold "npm run import -- empty.csv"
      And the PR body doesn't hold "Let me know if you want any changes."

  Rule: The reply from the report gives a body that ends at "Fixed it."

    @ac-2
    Scenario: The reported reply's PR body ends at "Fixed it." and holds none of the note after it
      Given the open-pr agent replies with this summary:
        """
        ```markdown
        ## Problem

        A PR body could keep a stray fence after its code block.

        ## What changes

        The wrapper now runs to its own closing fence.

        Fixed it.
        ```

        Note: to check it yourself, run:

        ```
        npm test -- src/cell/pr-body.test.ts
        ```
        """
      When the cell runs
      Then the summary part of the PR body ends with "Fixed it."
      And the PR body doesn't hold "Note: to check it yourself, run:"
      And the PR body doesn't hold "npm test -- src/cell/pr-body.test.ts"
      And the PR body doesn't hold "```"
      And the open-pr stage ran 1 attempt
      And the open-pr stage passed

  Rule: A wrapped body with code blocks inside it still reaches the PR whole, as PBI 291 made it

    @ac-3 @regression
    Scenario: A "markdown" wrapper with a code block inside, and chatter around it, still gives the body with its code block
      Given the open-pr agent replies with this summary:
        """
        Here is the PR body you asked for:

        ```markdown
        ## Problem

        Orders over 100 items time out.

        ## What changes

        Orders are saved in batches:

        ```ts
        await saveInBatches(order, 50);
        ```
        ```

        Let me know if you want any changes.
        """
      When the cell runs
      Then the summary part of the PR body is:
        """
        ## Problem

        Orders over 100 items time out.

        ## What changes

        Orders are saved in batches:

        ```ts
        await saveInBatches(order, 50);
        ```
        """
      And the PR body doesn't hold "Here is the PR body you asked for:"
      And the PR body doesn't hold "Let me know if you want any changes."
      And the PR body doesn't hold "```markdown"
      And the open-pr stage ran 1 attempt
      And the open-pr stage passed

    @ac-3 @regression
    Scenario: Several code blocks inside a wrapper are still all kept
      Given the open-pr agent replies with this summary:
        """
        ```md
        ## Problem

        Totals ignore VAT.

        Before:

        ```ts
        const total = net;
        ```

        After:

        ```ts
        const total = net * (1 + vat);
        ```
        ```
        """
      When the cell runs
      Then the summary part of the PR body is:
        """
        ## Problem

        Totals ignore VAT.

        Before:

        ```ts
        const total = net;
        ```

        After:

        ```ts
        const total = net * (1 + vat);
        ```
        """

    @ac-3 @regression
    Scenario: An inner code block with no language name of its own is still kept whole
      Given the open-pr agent replies with this summary:
        """
        ```markdown
        ## Problem

        The build skips the lint step.

        ## How to check

        ```
        npm run lint
        ```
        ```
        """
      When the cell runs
      Then the summary part of the PR body is:
        """
        ## Problem

        The build skips the lint step.

        ## How to check

        ```
        npm run lint
        ```
        """

