@pbi-133 @db
Feature: A dropped database connection no longer crashes the control plane
  The control plane keeps idle connections to Postgres in a pool. Today, when Postgres ends one of
  them, because an administrator ended it, the server restarted or the network dropped it, the pool
  reports an error that nothing handles, and the whole control plane process exits. The scheduler
  stops, the board poller stops and every open dashboard goes dark until someone restarts it.
  With this item, the control plane logs a lost connection, keeps running, and does its next piece
  of work on a fresh connection. Scenarios tagged @db need Postgres, which each test run starts for
  itself, so cells and CI both run them.

  Rule: Every database pool the factory makes survives a lost connection, and says so in the log

    @ac-1
    Scenario Outline: A pool made for <where> logs a lost connection and the process keeps running
      Given a database pool the factory made for <where>
      When the pool reports that one of its idle connections was lost
      Then the log says a database connection was lost, with the reason
      And the process is still running

      Examples:
        | where                                       |
        | a local database URL                        |
        | Azure, signing in as the managed identity   |

    @ac-1
    Scenario: Each pool the factory makes has its own handling, so a second pool is covered too
      Given two database pools the factory made for a local database URL
      When the second pool reports that one of its idle connections was lost
      Then the log says a database connection was lost, with the reason
      And the process is still running

    @ac-1
    Scenario: A lost connection the pool reports several times in a row never stops the process
      Given a database pool the factory made for a local database URL
      When the pool reports three lost idle connections in a row
      Then the log says a database connection was lost three times
      And the process is still running

  Rule: When Postgres ends an idle connection, the control plane's next query uses a fresh one

    @ac-2
    Scenario: The next query after Postgres ends an idle connection succeeds
      Given the control plane is running with a fake board
      And the control plane holds an idle connection to Postgres
      When Postgres ends that idle connection
      Then the control plane is still running
      And the log says a database connection was lost
      And the dashboard's Floor still answers 200 with the factory's items

    @ac-2
    Scenario: The next query after Postgres ends every idle connection at once succeeds
      Given the control plane is running with a fake board
      And the control plane holds several idle connections to Postgres
      When Postgres ends all of those idle connections at once
      Then the control plane is still running
      And the dashboard's Floor still answers 200 with the factory's items
      And the query ran on a connection Postgres opened after it ended the others

  Rule: After Postgres restarts, the scheduler and the board poller carry on by themselves

    @ac-3
    Scenario: The next scheduler tick after Postgres restarts succeeds
      Given the control plane is running with a fake board
      And an item ready for the factory to take
      And the scheduler has ticked at least once
      When Postgres restarts
      And the scheduler ticks once
      Then the control plane is still running, with no restart
      And the tick succeeded
      And the item is taken by the factory

    @ac-3
    Scenario: The next board poll after Postgres restarts succeeds
      Given the control plane is running with a fake board
      And the board poller has polled at least once
      When Postgres restarts
      And the fake board gains a new item
      And the board poller polls once
      Then the control plane is still running, with no restart
      And the poll succeeded
      And the new item is in the factory's backlog

    @ac-3
    Scenario: A tick while Postgres is still down fails and is logged, and the tick after it succeeds
      Given the control plane is running with a fake board
      And an item ready for the factory to take
      And the scheduler has ticked at least once
      When Postgres stops
      And the scheduler ticks once
      Then the log says the scheduler tick failed
      And the control plane is still running
      When Postgres starts again
      And the scheduler ticks once
      Then the tick succeeded
      And the item is taken by the factory

    @ac-3
    Scenario: A poll while Postgres is still down fails and is logged, and the poll after it succeeds
      Given the control plane is running with a fake board
      And the board poller has polled at least once
      When Postgres stops
      And the fake board gains a new item
      And the board poller polls once
      Then the log says polling the board failed
      And the control plane is still running
      When Postgres starts again
      And the board poller polls once
      Then the poll succeeded
      And the new item is in the factory's backlog

  Rule: After Postgres restarts, the dashboard's live event stream listens again

    @ac-4
    Scenario: An open dashboard reconnects after Postgres restarts and gets the next event
      Given the control plane is running with a fake board
      And the scheduler and the board poller have each run at least once
      And a viewer has the dashboard open on its live event stream
      When Postgres restarts
      Then the control plane is still running, with no restart
      And the viewer's live event stream is closed, so the browser reconnects
      When the viewer's browser reconnects to the live event stream
      And the factory records an event after the restart
      Then the viewer's live event stream delivers that event

    @ac-4
    Scenario: A dashboard that reconnects while Postgres is still down is refused, and listens once Postgres is back
      Given the control plane is running with a fake board
      And the scheduler and the board poller have each run at least once
      And a viewer has the dashboard open on its live event stream
      When Postgres stops
      And the viewer's browser reconnects to the live event stream
      Then the reconnect is refused
      And the control plane is still running
      When Postgres starts again
      And the viewer's browser reconnects to the live event stream
      And the factory records an event after the restart
      Then the viewer's live event stream delivers that event

    @ac-4
    Scenario: Two dashboards that reconnect after Postgres restarts share one listening connection again
      Given the control plane is running with a fake board
      And the scheduler and the board poller have each run at least once
      And two viewers have the dashboard open on its live event stream
      When Postgres restarts
      And both viewers' browsers reconnect to the live event stream
      And the factory records an event after the restart
      Then both viewers' live event streams deliver that event
      And the control plane holds exactly one connection listening for dashboard events
