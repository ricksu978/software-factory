-- GitHub logins are case-insensitive, and applyComment matches them with lower() (plan Task 15).
-- So two users can't hold the same login in different cases, and a comment maps to at most one user.
create unique index user_github_login_lower on "user" (lower(github_login));
