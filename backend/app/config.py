from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Database (Supabase Postgres — use the "Session mode" connection string)
    database_url: str

    # Supabase JWT verification
    supabase_url: str
    supabase_jwt_secret: str  # Found in Supabase → Settings → API → JWT Secret

    # AWS S3
    aws_access_key_id: str
    aws_secret_access_key: str
    aws_region: str = "us-east-1"
    aws_s3_bucket: str

    # CORS — comma-separated list of allowed origins
    # e.g. "https://peakme.vercel.app,http://localhost:5173"
    allowed_origins: str = "http://localhost:5173"

    # App
    environment: str = "development"

    @property
    def allowed_origins_list(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",")]


settings = Settings()
