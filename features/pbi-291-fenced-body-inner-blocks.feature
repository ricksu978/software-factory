@pbi-291
Feature: A fenced PR body with its own code block inside comes through clean, with no stray fence
  Open-pr cleans the agent's reply before it writes the PR body (PBI 216). When the reply wraps the
  body in one fenced block, only the fence's contents are kept. Today a body that holds its own code
  block breaks this. The inner block's closing fence is taken as the end of the wrapper, so the
  wrapper's real closing fence is left behind in the PR body as a stray fence, along with any chatter
  after it.
  With this item, a reply whose first fence line opens with a "markdown" or "md" language name, or
  with no language name, and whose last line that holds only a fence closes it, keeps everything
  between those two lines as the body, inner code blocks and all. A cleaned body that still leaves a
  code block open fails the open-pr attempt with a finding that says so, and the next attempt tells
  the agent to reply with the body alone. A body that already starts with "## Problem" and whose code
  blocks all close reaches the PR unchanged, as it does today.
  The scenarios run against a fake control plane, a fake agent and a fake repo host, so cells run
  them all. The "summary" is the agent's reply to open-pr. The "summary part" of the PR body is what
  comes before the factory's own "Refs #482" line.

  Background:
    Given a run for item 482 that resumes at open-pr
    And CI passes on every commit

  Rule: A wrapper fenced block keeps everything between its first and last fence lines, inner code blocks included

    @ac-1
    Scenario: A "markdown" wrapper with a code block inside, and chatter around it, gives the body with its code block
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

    @ac-1
    Scenario: An "md" wrapper with a code block inside gives the body with its code block
      Given the open-pr agent replies with this summary:
        """
        ```md
        ## Problem

        The import fails on empty rows.

        ```python
        rows = [r for r in rows if r]
        ```
        ```
        """
      When the cell runs
      Then the summary part of the PR body is:
        """
        ## Problem

        The import fails on empty rows.

        ```python
        rows = [r for r in rows if r]
        ```
        """
      And the PR body doesn't hold "```md"

    @ac-1
    Scenario: A wrapper with no language name and a code block inside gives the body with its code block
      Given the open-pr agent replies with this summary:
        """
        Sure.

        ```
        ## Problem

        The import fails on empty rows.

        ```python
        rows = [r for r in rows if r]
        ```
        ```
        """
      When the cell runs
      Then the summary part of the PR body is:
        """
        ## Problem

        The import fails on empty rows.

        ```python
        rows = [r for r in rows if r]
        ```
        """
      And the PR body doesn't hold "Sure."

    @ac-1
    Scenario: An inner code block with no language name of its own is kept whole
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

    @ac-1
    Scenario: Several code blocks inside a wrapper are all kept
      Given the open-pr agent replies with this summary:
        """
        Here's the summary:

        ```markdown
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
      And the PR body doesn't hold "Here's the summary:"

  Rule: A cleaned body that leaves a code block open fails the attempt, and the retry asks for the body alone

    @ac-2
    Scenario: A body that opens a code block and never closes it fails the open-pr attempt
      Given the open-pr agent's first reply is this summary:
        """
        ## Problem

        Orders over 100 items time out.

        ```ts
        await saveInBatches(order, 50);
        """
      And the open-pr agent's second reply starts with "## Problem"
      When the cell runs
      Then the open-pr stage's first attempt ends failed
      And that attempt's finding says the PR body leaves a code block open
      And no PR body holds "await saveInBatches(order, 50);"

    @ac-2
    Scenario: A wrapper whose inner code block never closes fails the open-pr attempt
      Given the open-pr agent's first reply is this summary:
        """
        ```markdown
        ## Problem

        The import fails on empty rows.

        ```python
        rows = [r for r in rows if r]
        ```
        """
      And the open-pr agent's second reply starts with "## Problem"
      When the cell runs
      Then the open-pr stage's first attempt ends failed
      And that attempt's finding says the PR body leaves a code block open
      And no PR body holds "rows = [r for r in rows if r]"

    @ac-2
    Scenario: A stray fence left at the end of the body fails the open-pr attempt
      Given the open-pr agent's first reply is this summary:
        """
        Here is the body:

        ## Problem

        Orders over 100 items time out.
        ```
        """
      And the open-pr agent's second reply starts with "## Problem"
      When the cell runs
      Then the open-pr stage's first attempt ends failed
      And that attempt's finding says the PR body leaves a code block open
      And no PR body holds "```"

    @ac-2
    Scenario: The retry after an open code block tells the agent to reply with the PR body alone
      Given the open-pr agent's first reply is this summary:
        """
        ## Problem

        Orders over 100 items time out.

        ```ts
        await saveInBatches(order, 50);
        """
      And the open-pr agent's second reply starts with "## Problem"
      When the cell runs
      Then the open-pr agent's second brief says its last attempt failed because the PR body leaves a code block open
      And the open-pr agent's second brief tells it to reply with the PR body alone, with nothing before or after it
      And the summary part of the PR body starts with "## Problem"
      And the open-pr stage passed

  Rule: A body that already starts with "## Problem" and closes its code blocks reaches the PR unchanged

    @ac-3 @regression
    Scenario: A clean body with a code block is used exactly as written
      Given the open-pr agent replies with this summary:
        """
        ## Problem

        Orders over 100 items time out.

        ## What changes

        Orders are saved in batches.

        ```ts
        await saveInBatches(order, 50);
        ```
        """
      When the cell runs
      Then the summary part of the PR body is:
        """
        ## Problem

        Orders over 100 items time out.

        ## What changes

        Orders are saved in batches.

        ```ts
        await saveInBatches(order, 50);
        ```
        """
      And the open-pr stage ran 1 attempt
      And the open-pr stage passed

    @ac-3 @regression
    Scenario: A clean body with several code blocks, one with no language name, is used exactly as written
      Given the open-pr agent replies with this summary:
        """
        ## Problem

        The build skips the lint step.

        ```
        npm run lint
        ```

        ## What changes

        ```yaml
        steps:
          - run: npm run lint
        ```
        """
      When the cell runs
      Then the summary part of the PR body is:
        """
        ## Problem

        The build skips the lint step.

        ```
        npm run lint
        ```

        ## What changes

        ```yaml
        steps:
          - run: npm run lint
        ```
        """
      And the open-pr stage ran 1 attempt
      And the open-pr stage passed
