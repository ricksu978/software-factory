@pbi-278
Feature: The SPA shell: a Vite build the BFF serves, shadcn/ui components, dark mode, session handling and a build script
  Step 8a of the control plane redesign (2026-11-07 design, §04 and §10) starts the React SPA that will replace
  today's dashboard. It is built with Vite, and the BFF serves the built files on 7403, beside today's
  dashboard on 7400 until step 9 moves it. The SPA talks to nothing but the BFF: its data comes from /bff/v1/*,
  and signing in and out goes through /auth/*.
  Its tables, badges, buttons, inputs, text areas and banners are shadcn/ui components kept in the repo and
  themed through shadcn's CSS variables. Like today's dashboard, it turns dark when the operating system is
  set to dark.
  When the BFF says there's no session, the SPA sends the browser to /auth/login. When the API says the person
  isn't one of the factory's users, the SPA shows the no-access page, as today's dashboard does.
  `npm run build` builds the SPA, and a type error in its code fails the build.
  This step is the shell. The floor, run detail and the Phase 0 pages move into the SPA in later steps.

  Rule: The BFF on 7403 serves the SPA's built files

    @ac-1
    Scenario: The BFF's home page is the SPA
      Given the SPA has been built
      And the BFF is running on 7403
      When a browser with no session opens "/"
      Then the BFF answers 200 with the SPA's page
      And the page loads the SPA's built script and stylesheet

    @ac-1
    Scenario: The SPA's built script and stylesheet are served to a browser with no session
      Given the SPA has been built
      And the BFF is running on 7403
      When a browser with no session opens each script and stylesheet the SPA's page names
      Then the BFF answers 200 for each, with the file's built contents

    @ac-1
    Scenario: A deep link to one of the SPA's pages gets the SPA's page
      Given the SPA has been built
      And the BFF is running on 7403
      When a browser opens "/runs/482"
      Then the BFF answers 200 with the SPA's page

    @ac-1
    Scenario: A missing built file gets 404, not the SPA's page
      Given the SPA has been built
      And the BFF is running on 7403
      When a browser opens "/"
      And a browser opens a script under the SPA's built files that the build didn't write
      Then the BFF answers 200 with the SPA's page for "/"
      And the BFF answers 404 for the missing script, not with the SPA's page

    @ac-1
    Scenario: Serving the SPA doesn't take over the BFF's own addresses
      Given the SPA has been built
      And the BFF is running on 7403
      When a browser with no session opens "/"
      And the same browser calls GET "/bff/v1/no-such-thing"
      And the same browser calls GET "/auth/session"
      Then the BFF answers 200 with the SPA's page for "/"
      And the BFF answers 401 for "/bff/v1/no-such-thing", not with the SPA's page
      And the BFF answers 401 for "/auth/session", not with the SPA's page

    @ac-1
    Scenario: The BFF serves only the built files, not the SPA's source or the repo
      Given the SPA has been built
      And the BFF is running on 7403
      When a browser opens "/"
      And a browser opens the address of one of the SPA's source files
      And a browser opens "/package.json"
      Then the BFF answers 200 with the SPA's page for "/"
      And neither of the other answers holds the file's contents

  Rule: The SPA calls only /bff/v1/* and /auth/*

    @ac-1
    Scenario: Every address the SPA calls is under /bff/v1 or /auth
      When I read the SPA's source
      Then it calls at least one address under "/bff/v1/"
      And every address it calls or sends the browser to starts with "/bff/v1/" or "/auth/"

    @ac-1
    Scenario: The SPA never calls the API, today's dashboard or another host directly
      When I read the SPA's source
      Then it names no address on port 7402 or 7400
      And it names no address with a scheme and host of its own

  Rule: Tables, badges, buttons, inputs, text areas and banners come from shadcn/ui components kept in the repo

    @ac-2
    Scenario: The repo keeps the shadcn/ui components the SPA uses
      When I read the SPA's source
      Then it has a shadcn/ui configuration
      And it keeps shadcn/ui's table, badge, button, input, textarea and alert components in the repo

    @ac-2
    Scenario: The SPA's pages draw tables, badges, buttons, inputs, text areas and banners only through those components
      When I read the SPA's source outside its shadcn/ui components
      Then it draws no table, button, input or text area element of its own
      And its banners use the shadcn/ui alert component
      And its badges use the shadcn/ui badge component

    @ac-2
    Scenario: The components are themed through shadcn's CSS variables
      Given the SPA has been built
      When I read the SPA's built stylesheet
      Then it defines shadcn's colour variables, including background, foreground, primary, muted, border and destructive
      And the shadcn/ui components take their colours from those variables

  Rule: Dark mode follows the operating system's setting

    @ac-3
    Scenario: With the operating system set to dark, the SPA is dark
      Given the SPA has been built
      And the operating system's colour scheme is dark
      When the SPA starts
      Then the SPA asks the operating system whether its colour scheme is dark
      And the SPA marks the page as dark
      And the SPA's built stylesheet gives shadcn's background and foreground variables their dark values on a page marked dark

    @ac-3
    Scenario: With the operating system set to light, the SPA is light
      Given the SPA has been built
      And the operating system's colour scheme is light
      When the SPA starts
      Then the SPA asks the operating system whether its colour scheme is dark
      And the SPA doesn't mark the page as dark
      And the SPA's built stylesheet gives shadcn's background and foreground variables their light values on a page not marked dark

    @ac-3
    Scenario Outline: When the operating system's setting changes while the SPA is open, the SPA follows it
      Given the operating system's colour scheme is <before>
      And the SPA has started
      When the operating system's colour scheme changes to <after>
      Then the SPA <marks> the page as dark

      Examples:
        | before | after | marks         |
        | light  | dark  | marks         |
        | dark   | light | doesn't mark  |

    @ac-3
    Scenario: The SPA offers no switch of its own, so the operating system's setting decides
      When I read the SPA's source
      Then it keeps no dark-mode choice of its own in storage or a cookie
      And it offers no control that switches between dark and light

  Rule: Without a session the SPA sends the browser to /auth/login

    @ac-4
    Scenario: Opening the SPA with no session goes to /auth/login
      Given the BFF answers 401 to the SPA's calls
      When the SPA starts
      Then the SPA sends the browser to "/auth/login"

    @ac-4
    Scenario: A session that ends while the SPA is open goes to /auth/login on the next call
      Given the SPA has started with a session
      And the BFF now answers 401 to the SPA's calls
      When the SPA makes its next call to "/bff/v1/floor"
      Then the SPA sends the browser to "/auth/login"

    @ac-4
    Scenario: With a session, the SPA stays where it is
      Given the BFF answers the SPA's calls with 200
      When the SPA starts
      Then the SPA shows its page
      And the SPA doesn't send the browser anywhere
      And it doesn't show the no-access page

  Rule: A 403 shows the no-access page

    @ac-4
    Scenario: A person the factory doesn't know sees the no-access page
      Given the BFF answers 403 to the SPA's calls
      When the SPA starts
      Then the SPA shows the no-access page
      And the page says "You don't have access to this factory. Ask an owner to add you."
      And the SPA doesn't send the browser to "/auth/login"

  Rule: `npm run build` builds the SPA and fails on a type error in it

    @ac-5
    Scenario: The build writes the SPA's files where the BFF serves them
      Given a scratch copy of the repo with its installed packages and no built SPA
      When I run "npm run build" in the scratch copy
      Then the command exits 0
      And the scratch copy holds the SPA's built page, script and stylesheet where the BFF serves them from

    @ac-5
    Scenario: A type error in the SPA fails the build
      Given a scratch copy of the repo with its installed packages
      And one of the SPA's source files in the scratch copy has a type error
      When I run "npm run build" in the scratch copy
      Then the command exits non-zero
      And the output names the file with the type error
