from sqlalchemy import create_engine
from server import Base, SQLALCHEMY_DATABASE_URL, UserDB, ChatDB, PatientDB, ChatImageDB, AuditLogDB, OTPDB, UserProfileDB, UserPromptDB

try:
    engine = create_engine(SQLALCHEMY_DATABASE_URL)
    print(f"Connecting to {SQLALCHEMY_DATABASE_URL}...")
    # Drop all existing tables to perform a clean reset
    Base.metadata.drop_all(bind=engine)
    print("Old tables dropped successfully!")
    # Create new tables
    Base.metadata.create_all(bind=engine)
    print("New tables created successfully!")
except Exception as e:
    print(f"Error creating tables: {e}")
