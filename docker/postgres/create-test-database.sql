-- Runs once, when the Postgres volume is first initialized. Tests get their
-- own database so they never touch development data.
CREATE DATABASE orbit_test;
