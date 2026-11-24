\getenv app_password FOLDLY_POSTGRES_APP_PASSWORD
CREATE ROLE foldly LOGIN PASSWORD :'app_password';
ALTER DATABASE foldly OWNER TO foldly;
