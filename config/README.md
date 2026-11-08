# config

`sources.yml` names the boards the factory reads, one entry per repo. An entry's `trustedBot` names the factory's GitHub App by its bot login, and migrate writes it to that repo's `trusted_bot`. The owner writes it in plan Task 18 Step 1. The migrate job reads it from here, so the control image copies this folder.
