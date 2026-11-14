@pbi-209
Feature: Run detail links a running stage's transcript, uploaded as it grows
  Today a stage's transcript reaches blob storage only when the stage ends, so Run detail has nothing to
  show while a long stage runs, and nothing at all for a stage whose cell dies part-way. With this item,
  while a stage runs the cell uploads the transcript so far to the stage attempt's usual path. It does
  so at most every 15 seconds, and only when the agent has written new messages since the last upload.
  Run detail links the transcript from the first upload. When the stage ends, the cell uploads the
  complete transcript to the same path, so the finished file is the one uploaded today. Tokens and
  cost for a running stage stay 0 until the stage ends, as today. An upload that fails during the
  stage is logged and skipped, and the next one tries again. A stage whose cell dies keeps its last
  upload, so Run detail still shows how far it got.

  Background:
    Given item "209" titled "Export a month" is an issue in the repo "acme/widgets"
    And the item's run is in progress in a cell

  Rule: While a stage runs, the cell uploads the transcript so far to the attempt's usual path, at most every 15 seconds and only when there's something new

    @ac-1
    Scenario: The transcript so far is uploaded to the attempt's usual path while the stage runs
      Given the item's "build" stage attempt 1 has started
      And its agent has written 3 messages
      When 15 seconds pass and the stage is still running
      Then the cell has uploaded a transcript to "transcripts/<run>/build-1.jsonl"
      And that transcript holds the 3 messages, one per line, in the order they were written

    @ac-1
    Scenario: A later upload holds the earlier messages and the new ones
      Given the item's "build" stage attempt 1 has started
      And its agent wrote 3 messages before the first upload
      And it has written 2 more messages since
      When 15 more seconds pass and the stage is still running
      Then the latest transcript uploaded to "transcripts/<run>/build-1.jsonl" holds all 5 messages in order

    @ac-1
    Scenario: The transcript so far covers every agent call the stage has made
      Given the item's "green" stage attempt 1 has started
      And its first agent call finished after writing 4 messages
      And its second agent call is still running and has written 2 messages
      When 15 seconds pass and the stage is still running
      Then the latest transcript uploaded to "transcripts/<run>/green-1.jsonl" holds the first call's 4 messages followed by the second call's 2

    @ac-1
    Scenario: Messages arriving all the time are uploaded no more often than every 15 seconds
      Given the item's "build" stage attempt 1 has started
      When its agent writes a message every second for 60 seconds while the stage keeps running
      Then the cell has uploaded the transcript so far at least once
      And no two of the uploads while the stage ran were less than 15 seconds apart
      And there were no more than 4 uploads while the stage ran

    @ac-1
    Scenario: Nothing is uploaded when no new messages have arrived since the last upload
      Given the item's "build" stage attempt 1 has started
      And its agent wrote 3 messages before the first upload
      When 45 seconds pass with no new messages and the stage still running
      Then the cell has uploaded the transcript exactly once while the stage ran

    @ac-1
    Scenario: Nothing is uploaded before the agent has written any message
      Given the item's "build" stage attempt 1 has started
      And its agent has written no messages yet
      When 30 seconds pass and the stage is still running
      Then the cell has uploaded no transcript for "build" attempt 1 yet
      When its agent writes 1 message and 15 more seconds pass
      Then the cell has uploaded a transcript to "transcripts/<run>/build-1.jsonl" holding that 1 message

    @ac-1
    Scenario: A second attempt uploads to its own path and leaves the first attempt's transcript alone
      Given the item's "build" stage attempt 1 failed, and its transcript is stored at "transcripts/<run>/build-1.jsonl"
      And the item's "build" stage attempt 2 has started
      And its agent has written 2 messages
      When 15 seconds pass and the stage is still running
      Then the cell has uploaded a transcript to "transcripts/<run>/build-2.jsonl" holding those 2 messages
      And the transcript stored at "transcripts/<run>/build-1.jsonl" is unchanged

  Rule: Run detail links a running stage's transcript from its first upload, showing everything up to that upload

    @ac-2
    Scenario: The link appears with the first upload, while the stage is still running
      Given the item's "build" stage attempt 1 has started
      And its agent has written no messages yet
      When a viewer opens the item's Run detail
      Then the Stages table shows no transcript link for "build" attempt 1
      When its agent writes 3 messages and the cell uploads the transcript so far
      And a viewer opens the item's Run detail
      Then the Stages table shows "build" attempt 1 as still running
      And the Stages table links the transcript for "build" attempt 1

    @ac-2
    Scenario: The link shows everything up to the latest upload
      Given the item's "build" stage attempt 1 has started
      And its agent wrote 3 messages before the cell uploaded the transcript so far
      And it has written 2 more messages since, which haven't been uploaded yet
      When a viewer follows the transcript link for "build" attempt 1 on Run detail
      Then the transcript shows the 3 messages written before the upload
      And it doesn't show the 2 messages written since

    @ac-2
    Scenario: Following the link again after a later upload shows the newer messages too
      Given the item's "build" stage attempt 1 has started
      And the cell uploaded the transcript so far when its agent had written 3 messages
      And the cell uploaded it again after its agent had written 2 more
      When a viewer follows the transcript link for "build" attempt 1 on Run detail
      Then the transcript shows all 5 messages in order

  Rule: Tokens and cost for a running stage stay 0 until the stage ends, as today

    @ac-3 @regression
    Scenario: A running stage shows no tokens and no cost, even after its first agent call has finished
      Given the item's "green" stage attempt 1 has started
      And its first agent call finished having used 12750 tokens in and 640 tokens out at a cost of $0.42
      And its second agent call is still running
      And the cell has uploaded the transcript so far
      When a viewer opens the item's Run detail
      Then the Stages table shows "0 in, 0 out" for "green" attempt 1
      And the Stages table shows a cost of exactly "$0.00" for "green" attempt 1

    @ac-3 @regression
    Scenario: A stage's tokens and cost show once it ends
      Given the item's "green" stage attempt 1 has started
      And the cell has uploaded the transcript so far
      When the stage passes, its agent calls having used 12750 tokens in and 640 tokens out at a cost of $0.42 in all
      And a viewer opens the item's Run detail
      Then the Stages table shows "12.8k in, 640 out" for "green" attempt 1
      And the Stages table shows a cost of exactly "$0.42" for "green" attempt 1

  Rule: When the stage ends, the complete transcript goes to the same path, as the file uploaded today

    @ac-4 @regression
    Scenario: A finished stage's stored transcript is its complete transcript, as today
      Given the item's "green" stage attempt 1 has started
      And its first agent call wrote 4 messages and its second wrote 3
      When the stage passes
      Then the transcript stored at "transcripts/<run>/green-1.jsonl" holds the first call's 4 messages followed by the second call's 3, one per line
      And Run detail links that transcript for "green" attempt 1

    @ac-4
    Scenario: A stage uploaded part-way ends with its complete transcript at the same path
      Given the item's "build" stage attempt 1 has started
      And its agent wrote 3 messages before the cell uploaded the transcript so far
      And it has written 4 more messages since
      When the stage passes
      Then "transcripts/<run>/build-1.jsonl" received an upload while the stage ran and another when it ended
      And the transcript stored there holds all 7 messages in order, the same as the complete transcript the stage would upload today
      And no other transcript path holds a copy for "build" attempt 1

    @ac-4
    Scenario: The upload at the end isn't held back by the 15-second spacing
      Given the item's "build" stage attempt 1 has started
      And the cell uploaded the transcript so far 2 seconds ago
      And its agent has written 1 more message since
      When the stage passes
      Then "transcripts/<run>/build-1.jsonl" received an upload while the stage ran and another when it ended
      And the cell uploaded the complete transcript there without waiting for 15 seconds to pass
      And the transcript stored there holds the last message

    @ac-4
    Scenario Outline: A stage that ends <how> also ends with its complete transcript at the same path
      Given the item's "build" stage attempt 1 has started
      And its agent wrote 3 messages before the cell uploaded the transcript so far
      And it has written 2 more messages since
      When the stage <ends>
      Then "transcripts/<run>/build-1.jsonl" received an upload while the stage ran and another when it ended
      And the transcript stored there holds all 5 messages in order

      Examples:
        | how                 | ends                          |
        | in failure          | fails                         |
        | stopped by an owner | is stopped from the dashboard |

  Rule: A failed upload during the stage is logged and skipped, never stops the stage, and the next upload tries again

    @ac-5
    Scenario Outline: An upload that fails because <cause> is logged and the stage carries on
      Given the item's "build" stage attempt 1 has started
      And its agent has written 3 messages
      And <cause>
      When the cell tries to upload the transcript so far
      Then the log says the transcript upload for "build" attempt 1 failed
      And the stage keeps running and its agent is not interrupted
      And the item stays InProgress

      Examples:
        | cause                                                            |
        | blob storage refuses the upload                                  |
        | the cell API can't be reached when the cell asks where to upload |

    @ac-5
    Scenario: The next upload tries again after a failure, even with no new messages
      Given the item's "build" stage attempt 1 has started
      And its agent has written 3 messages
      And the cell's first try at uploading the transcript so far failed
      And its agent has written no message since
      When 15 more seconds pass and the stage is still running
      Then the cell has tried again and uploaded a transcript to "transcripts/<run>/build-1.jsonl" holding the 3 messages

    @ac-5
    Scenario: A stage whose every upload fails while it runs still passes and stores its complete transcript at the end
      Given the item's "build" stage attempt 1 has started
      And blob storage refuses every upload while the stage runs
      And its agent writes a message every 5 seconds for 60 seconds
      When blob storage takes uploads again and the stage passes
      Then the log says the transcript upload for "build" attempt 1 failed
      And the Stages table shows "build" attempt 1 as passed
      And the transcript stored at "transcripts/<run>/build-1.jsonl" holds all 12 messages in order

  Rule: A stage whose cell dies mid-run keeps its last uploaded transcript

    @ac-6
    Scenario: Run detail still shows how far a stage got when its cell died
      Given the item's "build" stage attempt 1 has started
      And its agent wrote 5 messages before the cell uploaded the transcript so far
      And it wrote 2 more messages before the cell died without ending the stage
      When the run's lease expires
      And a viewer follows the transcript link for "build" attempt 1 on Run detail
      Then the transcript shows the 5 messages uploaded before the cell died
      And the Stages table shows "build" attempt 1 as stopped

    @ac-6
    Scenario: A later claim's attempt doesn't overwrite the transcript of the attempt whose cell died
      Given the item's "build" stage attempt 1 has started
      And its agent wrote 5 messages before the cell uploaded the transcript so far
      And the cell died without ending the stage, and the run's lease expired
      When the item is claimed again and its "build" stage attempt 2 runs and uploads its own transcript
      And a viewer opens the item's Run detail
      Then the Stages table links a transcript for "build" attempt 1 showing those 5 messages
      And the Stages table links a separate transcript for "build" attempt 2
