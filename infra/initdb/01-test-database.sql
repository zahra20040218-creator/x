-- A separate database for the test suite.
--
-- The real-infrastructure harness TRUNCATEs every table between tests and
-- FLUSHDBs Redis. Pointing that at the development database would silently
-- erase whatever you were working with, so the suite gets its own.
CREATE DATABASE rideapp_test OWNER rideapp;
