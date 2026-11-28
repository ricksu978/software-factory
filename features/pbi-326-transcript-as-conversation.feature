@pbi-326
Feature: Run detail shows a stage's transcript as a conversation, with the model's thinking, text, tool calls and results
  Today Run detail's transcript link opens the raw JSON Lines file: one SDK message per line, which is hard to read
  and can run to megabytes. With this item, the link opens a transcript page that shows the attempt as a
  conversation, in the order it happened. The brief the agent got comes first. Then come the turns. Each assistant
  turn shows its thinking, labelled as thinking, then its text, then its tool calls, each with the tool's name and a
  short form of its input, and each followed by its result. A long input or result shows its first lines and opens
  to the rest, so a large transcript reads as a page of short turns. Subagent tasks show where they start and finish,
  with the subagent's name. The final result shows the attempt's cost, tokens and how it ended.
  Everything from the transcript shows as text, never as HTML. A transcript of an attempt still running shows what
  PBI 209 has uploaded so far and says the attempt is still running. The raw JSON Lines file stays one click away.
  Cost and tokens read as Run detail formats them (PBI 189).

  Background:
    Given transcripts can be served
    And item "#326 Add search" has a "build" stage attempt 1 with a stored transcript

  # ---------------------------------------------------------------------------------------------------------------
  # AC-1: The page, in the order it happened
  # ---------------------------------------------------------------------------------------------------------------

  Rule: Run detail's transcript link opens a page showing the attempt as a conversation: the brief first, then each turn in order

    @ac-1
    Scenario: The transcript link opens the conversation, brief first
      Given the attempt's agent was given the brief "Write the feature files for item 326"
      And its transcript holds, in order, an assistant turn saying "I'll read the spec first", a call to "Read" and its result, and an assistant turn saying "Done"
      When I follow the transcript link for "build" attempt 1 on Run detail
      Then I see the transcript page for "build" attempt 1 of "#326 Add search"
      And the page shows the brief "Write the feature files for item 326" first
      And after the brief it shows, in order, "I'll read the spec first", the "Read" call, its result, and "Done"

    @ac-1
    Scenario: The brief is labelled as the brief, set apart from the agent's own turns
      Given the attempt's agent was given the brief "Write the feature files for item 326"
      When I open the transcript page for "build" attempt 1
      Then the brief is labelled as the brief the agent got
      And it isn't shown as one of the assistant's turns

    @ac-1
    Scenario: An attempt that made two agent calls shows each call's brief before that call's turns
      Given the attempt made two agent calls
      And the first call was given the brief "Make the scenarios pass" and its assistant said "First pass done"
      And the second call was given the brief "Fix the failing scenario" and its assistant said "Second pass done"
      When I open the transcript page for "build" attempt 1
      Then the page shows, in order, "Make the scenarios pass", "First pass done", "Fix the failing scenario" and "Second pass done"

    @ac-1
    Scenario: Messages that aren't part of the conversation don't show as turns
      Given the attempt's transcript holds a rate limit event and a task progress update between two assistant turns
      When I open the transcript page for "build" attempt 1
      Then the page shows the two assistant turns one after the other
      And it shows no turn for the rate limit event or the task progress update

    @ac-1
    Scenario: A line the page can't read shows as plain text in its place, and the rest of the conversation still shows
      Given the attempt's transcript holds an assistant turn saying "Before", then a line that isn't valid JSON reading "{oops", then an assistant turn saying "After"
      When I open the transcript page for "build" attempt 1
      Then the page shows, in order, "Before", "{oops" as plain text, and "After"

    @ac-1
    Scenario: A transcript that is no longer stored says so
      Given the stored transcript for "build" attempt 1 has been deleted
      When I open the transcript page for "build" attempt 1
      Then the page says the transcript can't be found
      And it shows no turns

  # ---------------------------------------------------------------------------------------------------------------
  # AC-2: An assistant turn
  # ---------------------------------------------------------------------------------------------------------------

  Rule: An assistant turn shows its thinking, labelled as thinking, then its text, then each tool call with the tool's name and a short form of its input

    @ac-2
    Scenario: An assistant turn shows thinking, then text, then its tool calls
      Given an assistant turn in the attempt's transcript holds the thinking "The spec is in docs, so read it", the text "Reading the spec" and a call to "Read" with the file path "docs/spec.html"
      When I open the transcript page for "build" attempt 1
      Then that turn shows, in order, the thinking, the text and the "Read" call
      And the thinking "The spec is in docs, so read it" is labelled as thinking
      And the text "Reading the spec" isn't labelled as thinking
      And the "Read" call shows the tool's name "Read" and "docs/spec.html"

    @ac-2
    Scenario Outline: A call to <tool> shows a short form of its input
      Given an assistant turn in the attempt's transcript calls "<tool>" with the input <input>
      When I open the transcript page for "build" attempt 1
      Then the call shows the tool's name "<tool>" and "<short>"
      And it doesn't show the input as raw JSON

      Examples:
        | tool  | input                                                                   | short                        |
        | Bash  | {"command": "npm test", "description": "Run the tests"}                 | npm test                     |
        | Read  | {"file_path": "src/api/items.ts"}                                       | src/api/items.ts             |
        | Edit  | {"file_path": "src/api/items.ts", "old_string": "a", "new_string": "b"} | src/api/items.ts             |
        | Grep  | {"pattern": "transcript_ref", "path": "src"}                            | transcript_ref               |

    @ac-2
    Scenario: A call to a tool the page doesn't know still shows its name and its input
      Given an assistant turn in the attempt's transcript calls "mcp__acme__lookup" with the input {"ticket": "ACME-12"}
      When I open the transcript page for "build" attempt 1
      Then the call shows the tool's name "mcp__acme__lookup" and "ACME-12"

    @ac-2
    Scenario: A turn with several tool calls shows each one, in the order the model made them
      Given an assistant turn in the attempt's transcript calls "Read" on "a.ts", then "Read" on "b.ts", then "Bash" with "npm test"
      When I open the transcript page for "build" attempt 1
      Then that turn shows the calls in order: "Read" with "a.ts", "Read" with "b.ts", "Bash" with "npm test"

    @ac-2
    Scenario: A turn with only text shows no thinking and no tool calls
      Given an assistant turn in the attempt's transcript holds only the text "All scenarios written"
      When I open the transcript page for "build" attempt 1
      Then that turn shows "All scenarios written"
      And that turn shows nothing labelled as thinking
      And that turn shows no tool call

    @ac-2
    Scenario: Thinking whose words were withheld still shows as thinking, without pretending to have text
      Given an assistant turn in the attempt's transcript holds redacted thinking, then the text "Next I'll run the tests"
      When I open the transcript page for "build" attempt 1
      Then that turn shows a part labelled as thinking that says its content was withheld
      And then it shows "Next I'll run the tests"

  # ---------------------------------------------------------------------------------------------------------------
  # AC-3: Results, and long inputs and results
  # ---------------------------------------------------------------------------------------------------------------

  Rule: Each tool call is followed by its result

    @ac-3
    Scenario: A tool call's result follows the call
      Given an assistant turn in the attempt's transcript calls "Bash" with "npm test"
      And the result of that call is "12 passing"
      When I open the transcript page for "build" attempt 1
      Then "12 passing" shows straight after the "Bash" call with "npm test", as its result

    @ac-3
    Scenario: Each of several calls in one turn is followed by its own result, even when the results arrive together
      Given an assistant turn in the attempt's transcript calls "Read" on "a.ts" and "Read" on "b.ts"
      And the next message in the transcript holds both results, the one for "b.ts" first: "contents of b" and "contents of a"
      When I open the transcript page for "build" attempt 1
      Then "contents of a" shows as the result of the "Read" call on "a.ts"
      And "contents of b" shows as the result of the "Read" call on "b.ts"

    @ac-3
    Scenario: A result that is an error shows as an error
      Given an assistant turn in the attempt's transcript calls "Read" on "missing.ts"
      And the result of that call is the error "File does not exist"
      When I open the transcript page for "build" attempt 1
      Then the result of the "Read" call shows "File does not exist" marked as an error

    @ac-3
    Scenario: A call with no result yet says it has no result
      Given the attempt's transcript ends with an assistant turn calling "Bash" with "npm test" and no result for it
      When I open the transcript page for "build" attempt 1
      Then the "Bash" call with "npm test" says it has no result yet

  Rule: A long input or result shows its first lines and opens to the rest, so a large transcript reads as a page of short turns

    @ac-3
    Scenario: A long result shows its first lines and opens to the rest
      Given an assistant turn in the attempt's transcript calls "Bash" with "npm test"
      And the result of that call is 400 lines long, the first reading "line 1 of 400" and the last "line 400 of 400"
      When I open the transcript page for "build" attempt 1
      Then the result shows "line 1 of 400"
      And it doesn't show "line 400 of 400"
      And it offers to show the rest
      When I open the rest of that result
      Then it shows all 400 lines, ending with "line 400 of 400"

    @ac-3
    Scenario: A long input shows its first lines and opens to the rest
      Given an assistant turn in the attempt's transcript calls "Write" on "big.ts" with content 300 lines long, the last reading "end of big.ts"
      When I open the transcript page for "build" attempt 1
      Then the "Write" call shows "big.ts"
      And it doesn't show "end of big.ts"
      When I open the rest of that call's input
      Then it shows all 300 lines, ending with "end of big.ts"

    @ac-3
    Scenario: A short result shows whole, with nothing to open
      Given an assistant turn in the attempt's transcript calls "Bash" with "git status"
      And the result of that call is 3 lines long
      When I open the transcript page for "build" attempt 1
      Then the result shows all 3 lines
      And it offers nothing more to open

    @ac-3
    Scenario: A long result on a single line is shortened too
      Given an assistant turn in the attempt's transcript calls "Bash" with "cat bundle.js"
      And the result of that call is one line of 200,000 characters, ending in "END-OF-BUNDLE"
      When I open the transcript page for "build" attempt 1
      Then the result doesn't show "END-OF-BUNDLE"
      And it offers to show the rest
      When I open the rest of that result
      Then it shows "END-OF-BUNDLE"

    @ac-3
    Scenario: A 1 MB transcript opens as a page of short turns, not a wall of output
      Given the attempt's transcript is 1 MB, made of 40 turns whose tool results are each thousands of lines long
      When I open the transcript page for "build" attempt 1
      Then the page shows all 40 turns
      And each of their tool results shows only its first lines until opened
      And the text the page shows before anything is opened is a small part of the transcript's 1 MB

  # ---------------------------------------------------------------------------------------------------------------
  # AC-4: Subagents and the final result
  # ---------------------------------------------------------------------------------------------------------------

  Rule: A subagent task shows where it starts and where it finishes, with the subagent's name

    @ac-4
    Scenario: A subagent task shows its start and finish with the subagent's name
      Given the attempt's transcript holds a subagent task "factory-self-reviewer" described as "Review the branch" starting after the assistant's turn "Asking for a review"
      And it holds that task finishing as completed with the summary "APPROVED", before the assistant's turn "Review approved"
      When I open the transcript page for "build" attempt 1
      Then the page shows, in order, "Asking for a review", the start of subagent "factory-self-reviewer", the finish of subagent "factory-self-reviewer", and "Review approved"
      And the start shows "Review the branch"
      And the finish shows "APPROVED"

    @ac-4
    Scenario Outline: A subagent task that ended <how> says so at its finish
      Given the attempt's transcript holds a subagent task "factory-self-reviewer" that started and then finished as <status>
      When I open the transcript page for "build" attempt 1
      Then the finish of subagent "factory-self-reviewer" says it <how>

      Examples:
        | status    | how       |
        | completed | completed |
        | failed    | failed    |
        | stopped   | stopped   |

    @ac-4
    Scenario: Two subagent tasks each show their own start and finish
      Given the attempt's transcript holds subagent "factory-self-reviewer" starting, then subagent "Explore" starting, then "Explore" finishing, then "factory-self-reviewer" finishing
      When I open the transcript page for "build" attempt 1
      Then the page shows each start and finish in that order, each with its subagent's name

    @ac-4
    Scenario: A subagent task with no finish in the transcript shows only its start
      Given the attempt's transcript holds subagent "factory-self-reviewer" starting and never finishing
      When I open the transcript page for "build" attempt 1
      Then the page shows the start of subagent "factory-self-reviewer"
      And it shows no finish for it

  Rule: The final result shows the attempt's cost, tokens and how it ended

    @ac-4
    Scenario: The final result shows the cost, tokens and that the attempt succeeded
      Given the attempt's transcript ends with a result of success, costing $0.4213, with 12750 tokens in and 640 tokens out
      When I open the transcript page for "build" attempt 1
      Then the page ends with the final result
      And the final result shows a cost of "$0.42"
      And the final result shows "12.8k in, 640 out"
      And the final result says the attempt succeeded

    @ac-4
    Scenario Outline: A final result of <subtype> says the attempt <ended>
      Given the attempt's transcript ends with a result of <subtype>
      When I open the transcript page for "build" attempt 1
      Then the final result says the attempt <ended>

      Examples:
        | subtype                             | ended                       |
        | error_max_turns                     | ran out of turns            |
        | error_during_execution              | failed with an error        |
        | error_max_budget_usd                | ran out of budget           |
        | success marked as an error          | failed with an error        |

    @ac-4
    Scenario: An attempt that made two agent calls shows each call's final result
      Given the attempt made two agent calls
      And the first call ended in success costing $0.30, and the second in success costing $0.12
      When I open the transcript page for "build" attempt 1
      Then the first call's final result shows "$0.30" before the second call's brief
      And the second call's final result shows "$0.12" at the end of the page

  # ---------------------------------------------------------------------------------------------------------------
  # AC-5: Text, never HTML
  # ---------------------------------------------------------------------------------------------------------------

  Rule: Everything from the transcript is shown as text, never as HTML

    @ac-5
    Scenario Outline: Markup in <where> shows as the text it is
      Given the attempt's <where> holds "<b>bold</b><script>window.pwned = 1</script><img src=x onerror=alert(1)>"
      When I open the transcript page for "build" attempt 1
      Then the page shows "<b>bold</b><script>window.pwned = 1</script><img src=x onerror=alert(1)>" as text
      And the page has no script, image or bold element that came from the transcript
      And no script from the transcript has run

      Examples:
        | where                               |
        | brief                               |
        | assistant's thinking                |
        | assistant's text                    |
        | tool call's input                   |
        | tool result                         |
        | tool result's rest, once opened     |
        | subagent's name and description     |
        | final result's message              |
        | line the page can't read            |

    @ac-5
    Scenario: A tool name holding markup shows as text
      Given an assistant turn in the attempt's transcript calls a tool named "<i>Bash</i>"
      When I open the transcript page for "build" attempt 1
      Then the call shows the tool's name "<i>Bash</i>" as text
      And the page has no italic element that came from the transcript

    @ac-5
    Scenario: Markdown in the assistant's text isn't turned into a link
      Given an assistant turn in the attempt's transcript says "[click me](javascript:alert(1))"
      When I open the transcript page for "build" attempt 1
      Then the page shows "[click me](javascript:alert(1))" as text
      And the page has no link to "javascript:alert(1)"

  # ---------------------------------------------------------------------------------------------------------------
  # AC-6: An attempt still running
  # ---------------------------------------------------------------------------------------------------------------

  Rule: The transcript of an attempt still running shows what has been uploaded so far and says the attempt is still running

    @ac-6
    Scenario: A running attempt shows what has been uploaded so far and says it's still running
      Given item "#326 Add search" is In progress and its "build" stage attempt 1 is still running
      And the cell has uploaded the transcript so far, holding the brief and 3 assistant turns
      And the agent has written 2 more turns since, which haven't been uploaded yet
      When I follow the transcript link for "build" attempt 1 on Run detail
      Then the page shows the brief and the 3 uploaded turns
      And it doesn't show the 2 turns written since
      And the page says the attempt is still running
      And the page shows no final result

    @ac-6
    Scenario: Opening the page again after a later upload shows the newer turns too
      Given item "#326 Add search" is In progress and its "build" stage attempt 1 is still running
      And the cell uploaded the transcript so far with 3 assistant turns, and again with 5
      When I open the transcript page for "build" attempt 1
      Then the page shows all 5 turns in order
      And the page says the attempt is still running

    @ac-6
    Scenario: A finished attempt doesn't say it's still running
      Given the "build" stage attempt 1 has passed and its complete transcript is stored
      When I open the transcript page for "build" attempt 1
      Then the page doesn't say the attempt is still running
      And the page shows the final result

    @ac-6
    Scenario: An attempt whose cell died doesn't say it's still running
      Given the "build" stage attempt 1 started, the cell uploaded the transcript so far with 3 turns, and then the cell died without ending the stage
      And the run's lease has expired
      When I open the transcript page for "build" attempt 1
      Then the page shows the 3 uploaded turns
      And the page doesn't say the attempt is still running
      And the page says the attempt stopped before it finished

    @ac-6
    Scenario: A running attempt whose upload ends part-way through a line still shows the lines before it
      Given item "#326 Add search" is In progress and its "build" stage attempt 1 is still running
      And the transcript uploaded so far holds 3 assistant turns and then half of a fourth line
      When I open the transcript page for "build" attempt 1
      Then the page shows the 3 turns
      And the page says the attempt is still running

  # ---------------------------------------------------------------------------------------------------------------
  # AC-7: The raw file
  # ---------------------------------------------------------------------------------------------------------------

  Rule: The raw JSON Lines file stays one click away from the page

    @ac-7
    Scenario: The page links the raw JSON Lines file
      Given the attempt's transcript is stored as "transcripts/326/build-1.jsonl"
      When I open the transcript page for "build" attempt 1
      Then the page has a link to the raw JSON Lines file
      And following that link gives the stored "transcripts/326/build-1.jsonl" exactly as stored

    @ac-7
    Scenario: A running attempt's page links the raw file uploaded so far
      Given item "#326 Add search" is In progress and its "build" stage attempt 1 is still running
      And the cell has uploaded the transcript so far as "transcripts/326/build-1.jsonl"
      When I open the transcript page for "build" attempt 1
      Then the page has a link to the raw JSON Lines file
      And following that link gives the transcript uploaded so far, exactly as stored

    @ac-7
    Scenario: The raw link is there even when the page can't read the transcript
      Given the attempt's stored transcript holds no line the page can read
      When I open the transcript page for "build" attempt 1
      Then the page has a link to the raw JSON Lines file
