@pbi-170 @db
Feature: seed-owner seeds an owner by sign-in issuer as well as by provider
  Step 5 of the control plane redesign (2026-11-07 design, §08) signs people in through one OIDC
  issuer, such as the local Keycloak realm, and knows each user by that issuer and their subject.
  So the migrate job's seed-owner command takes issuer= as well as provider=, and the first owner
  can be seeded before anyone signs in. An issuer is a URL, and each issuer has its own subjects.
  Owners seeded by provider keep working as they do today. Scenarios tagged @db need Postgres,
  which each test starts for itself.

  Rule: seed-owner adds or promotes an owner known by an issuer and a subject

    @ac-1
    Scenario: seed-owner adds a first owner from an issuer
      When the migrate job runs seed-owner with "issuer=https://id.example.com/realms/factory subject=kc-1 email=me@example.com product-owner"
      Then it exits 0
      And the user "kc-1" loads with the issuer "https://id.example.com/realms/factory" and no provider
      And the user "kc-1" is an owner and a product owner

    @ac-1
    Scenario: seed-owner accepts a local issuer on plain http
      When the migrate job runs seed-owner with "issuer=http://localhost:7430/realms/factory subject=kc-local"
      Then it exits 0
      And the user "kc-local" loads with the issuer "http://localhost:7430/realms/factory" and no provider
      And the user "kc-local" is an owner

    @ac-1
    Scenario: seed-owner promotes a user the issuer already knows, rather than adding a second one
      Given the user "kc-2" from the issuer "https://id.example.com/realms/factory" is a viewer
      When the migrate job runs seed-owner with "issuer=https://id.example.com/realms/factory subject=kc-2"
      Then it exits 0
      And exactly one user "kc-2" from the issuer "https://id.example.com/realms/factory" exists
      And the user "kc-2" from the issuer "https://id.example.com/realms/factory" is an owner

    @ac-1
    Scenario: The same subject from another issuer is a different owner
      Given the user "kc-3" from the issuer "https://id.example.com/realms/factory" is an owner
      When the migrate job runs seed-owner with "issuer=https://login.example.org subject=kc-3"
      Then it exits 0
      And there are two users "kc-3", one from each issuer, and both are owners

  Rule: seed-owner refuses an owner it couldn't match to a sign-in

    @ac-1
    Scenario: seed-owner refuses an owner with neither a provider nor an issuer, and names both
      When the migrate job runs seed-owner with "subject=s-5 email=me@example.com"
      Then it exits 1 naming "provider=" and "issuer="
      And no user "s-5" exists

    @ac-1
    Scenario Outline: seed-owner refuses an issuer that isn't a URL
      When the migrate job runs seed-owner with "<issuer word> subject=s-6"
      Then it exits 1 saying the issuer must be a URL
      And no user "s-6" exists

      Examples:
        | issuer word      |
        | issuer=keycloak  |
        | issuer=          |

    @ac-1
    Scenario: seed-owner refuses an issuer with no subject
      When the migrate job runs seed-owner with "issuer=https://id.example.com/realms/factory email=me@example.com"
      Then it exits 1 naming "subject="
      And no user from the issuer "https://id.example.com/realms/factory" exists

  Rule: Seeding an owner by provider works as it does today

    @ac-1 @regression
    Scenario: seed-owner still adds a first owner from a provider
      When the migrate job runs seed-owner with "provider=google subject=g-7 email=me@example.com product-owner"
      Then it exits 0
      And the user "g-7" is an owner and a product owner
