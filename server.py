import uvicorn
import httpx
import json
from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel
from typing import List, Optional, Dict, Any 
from passlib.context import CryptContext
from datetime import datetime, timedelta, timezone
import jwt

# --- 1. MySQL Setup ---
from sqlalchemy import create_engine, Column, Integer, String, DateTime, JSON, Text, Boolean
from sqlalchemy.dialects.mysql import LONGTEXT
from sqlalchemy.orm import sessionmaker, Session, declarative_base

# เชื่อมต่อ XAMPP MySQL (User: root, Pass: ว่าง)
SQLALCHEMY_DATABASE_URL = "mysql+pymysql://root:@localhost/medgemma_db"

try:
    engine = create_engine(SQLALCHEMY_DATABASE_URL)
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base = declarative_base()
    print("[OK] เชื่อมต่อ MySQL สำเร็จ")
except Exception as e:
    print(f"[Error] เชื่อมต่อ MySQL ไม่ได้: {e}")
    print("[Warning] อย่าลืมเปิด XAMPP (Start Apache & MySQL)")

# --- 2. Database Models ---
class UserDB(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(100), unique=True, index=True)
    password = Column(String(255))
    email = Column(String(255), nullable=True) # made nullable for old users, but required in schema
    role = Column(String(50), default="user") # e.g., admin, doctor, user
    is_active = Column(Integer, default=1) # 1 = active, 0 = inactive using integer for boolean compatibility
    is_verified = Column(Boolean, default=False)

class OTPDB(Base):
    __tablename__ = "otp_codes"
    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(255), index=True)
    otp_code = Column(String(10))
    expires_at = Column(DateTime)

class UserProfileDB(Base):
    __tablename__ = "user_profiles"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, index=True) # Reference to UserDB.id
    first_name = Column(String(150), nullable=True)
    last_name = Column(String(150), nullable=True)
    phone = Column(String(50), nullable=True)
    bio = Column(Text, nullable=True)
    profile_picture_url = Column(LONGTEXT, nullable=True)

class UserPromptDB(Base):
    __tablename__ = "user_prompts"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, index=True) # Reference to UserDB.id
    symptom_prompt = Column(Text, nullable=True)
    vision_prompt = Column(Text, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class PatientDB(Base):
    __tablename__ = "patients"
    id = Column(Integer, primary_key=True, index=True)
    hn_number = Column(String(100), unique=True, index=True)
    first_name = Column(String(150))
    last_name = Column(String(150))
    date_of_birth = Column(DateTime, nullable=True)
    gender = Column(String(50), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    created_by = Column(Integer, index=True) # Foreign Key concept to UserDB.id

class ChatDB(Base):
    __tablename__ = "chats"
    id = Column(String(100), primary_key=True, index=True) 
    owner = Column(String(100), index=True) # Could refer to UserDB.username
    patient_id = Column(Integer, index=True, nullable=True) # Reference to PatientDB.id
    title = Column(String(255))
    type = Column(String(50))
    messages = Column(JSON) 
    summary = Column(Text, nullable=True) # Extracted summary from chat
    timestamp = Column(DateTime, default=datetime.utcnow)

class ChatImageDB(Base):
    __tablename__ = "chat_images"
    id = Column(Integer, primary_key=True, index=True)
    chat_id = Column(String(100), index=True) # Reference to ChatDB.id
    image_url = Column(Text) # the path, url, or base64 representation
    uploaded_at = Column(DateTime, default=datetime.utcnow)

class AuditLogDB(Base):
    __tablename__ = "audit_logs"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, index=True) # Reference to UserDB.id
    action = Column(String(255))
    ip_address = Column(String(100), nullable=True)
    timestamp = Column(DateTime, default=datetime.utcnow)

try:
    Base.metadata.create_all(bind=engine)
except Exception:
    pass 

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# --- Config App ---
app = FastAPI()
SECRET_KEY = "medgemma_secret_key"
ALGORITHM = "HS256"

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/auth/login")

# --- Models ---
class UserRegister(BaseModel):
    username: str
    password: str
    email: str

class UserLogin(BaseModel):
    username: str
    password: str

class OTPVerify(BaseModel):
    email: str
    otp_code: str

class ProfileSchema(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    phone: Optional[str] = None
    bio: Optional[str] = None
    profile_picture_url: Optional[str] = None

class PromptsSchema(BaseModel):
    symptom_prompt: Optional[str] = None
    vision_prompt: Optional[str] = None

class PatientSchema(BaseModel):
    hn_number: str
    first_name: str
    last_name: str
    date_of_birth: Optional[datetime] = None
    gender: Optional[str] = None

class ChatSchema(BaseModel):
    id: str
    title: str
    type: str
    patient_id: Optional[int] = None
    summary: Optional[str] = None
    messages: List[Dict[str, Any]]
    timestamp: Optional[datetime] = None

class OllamaRequest(BaseModel):
    model: str
    messages: List[Dict[str, Any]]
    stream: bool = False

# --- Helper Functions ---
def verify_password(plain, hashed): return pwd_context.verify(plain, hashed)
def get_password_hash(password): return pwd_context.hash(password)

def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(hours=24)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

def get_current_user(token: str = Depends(oauth2_scheme)):
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username = payload.get("sub")
        if username is None: raise HTTPException(401)
        return username
    except:
        raise HTTPException(401, detail="Token invalid")

# --- API Endpoints ---
@app.get("/")
def read_root():
    return {"status": "ok", "message": "MedGemma API (Ollama Mode) Running"}

@app.post("/api/auth/register")
def register(user: UserRegister, db: Session = Depends(get_db)):
    if db.query(UserDB).filter(UserDB.username == user.username).first():
        raise HTTPException(400, detail="ชื่อผู้ใช้นี้ถูกใช้แล้ว")
    if db.query(UserDB).filter(UserDB.email == user.email).first():
        raise HTTPException(400, detail="อีเมลนี้ถูกใช้แล้ว")
        
    import re
    if len(user.password) < 8 or not re.search(r"[A-Z]", user.password) or not re.search(r"[a-z]", user.password) or not re.search(r"[0-9]", user.password):
        raise HTTPException(400, detail="รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร ประกอบด้วยตัวพิมพ์ใหญ่ พิมพ์เล็ก และตัวเลข")

    new_user = UserDB(
        username=user.username, 
        password=get_password_hash(user.password),
        email=user.email,
        is_verified=False
    )
    db.add(new_user)
    db.commit()
    
    # Generate OTP
    import random
    otp = str(random.randint(100000, 999999))
    expires = datetime.utcnow() + timedelta(minutes=5)
    
    # Invalidate old OTPs
    db.query(OTPDB).filter(OTPDB.email == user.email).delete()
    db.add(OTPDB(email=user.email, otp_code=otp, expires_at=expires))
    
    # Audit Log
    db.add(AuditLogDB(user_id=new_user.id, action="REGISTER_PENDING_OTP"))
    db.commit()
    
    # Simulate sending email by printing
    print(f"\n=========================================")
    print(f"📧 ส่ง OTP ไปที่อีเมล: {user.email}")
    print(f"🔑 รหัส OTP ของคุณคือ: {otp} (หมดอายุใน 5 นาที)")
    print(f"=========================================\n")
    
    return {"message": "สมัครสมาชิกสำเร็จ กรุณายืนยันรหัส OTP จากอีเมล"}

@app.post("/api/auth/verify-otp")
def verify_otp(payload: OTPVerify, db: Session = Depends(get_db)):
    record = db.query(OTPDB).filter(OTPDB.email == payload.email, OTPDB.otp_code == payload.otp_code).first()
    
    if not record:
        raise HTTPException(400, detail="รหัส OTP ไม่ถูกต้อง")
    if record.expires_at < datetime.utcnow():
        raise HTTPException(400, detail="รหัส OTP หมดอายุแล้ว")
        
    db_user = db.query(UserDB).filter(UserDB.email == payload.email).first()
    if not db_user:
        raise HTTPException(404, detail="ไม่พบผู้ใช้งานด้วยอีเมลนี้")
        
    db_user.is_verified = True
    db.query(OTPDB).filter(OTPDB.email == payload.email).delete()
    
    db.add(AuditLogDB(user_id=db_user.id, action="VERIFY_OTP_SUCCESS"))
    db.commit()
    
    return {"message": "ยืนยันตัวตนสำเร็จ"}

@app.post("/api/auth/login")
def login(user: UserLogin, db: Session = Depends(get_db)):
    db_user = db.query(UserDB).filter(UserDB.username == user.username).first()
    
    if not db_user or not verify_password(user.password, db_user.password):
        raise HTTPException(401, detail="ชื่อผู้ใช้หรือรหัสผ่านผิด")
    if db_user.is_active == 0:
        raise HTTPException(401, detail="บัญชีถูกระงับ")
    if not db_user.is_verified:
        raise HTTPException(403, detail="กรุณายืนยันอีเมล OTP ก่อนเข้าใช้งาน")
        
    # Audit Log
    db.add(AuditLogDB(user_id=db_user.id, action="LOGIN"))
    db.commit()
    
    return {"access_token": create_access_token({"sub": user.username}), "token_type": "bearer", "username": user.username, "role": db_user.role}

@app.get("/api/auth/me")
def get_me(user: str = Depends(get_current_user), db: Session = Depends(get_db)):
    db_user = db.query(UserDB).filter(UserDB.username == user).first()
    if not db_user:
        raise HTTPException(404, detail="ไม่พบผู้ใช้งานนี้")
    return {
        "username": db_user.username,
        "email": db_user.email,
        "role": db_user.role,
        "is_active": db_user.is_active,
        "is_verified": db_user.is_verified
    }

@app.get("/api/profile")
def get_profile(user: str = Depends(get_current_user), db: Session = Depends(get_db)):
    db_user = db.query(UserDB).filter(UserDB.username == user).first()
    if not db_user:
        raise HTTPException(404, detail="ไม่พบผู้ใช้งาน")
        
    profile = db.query(UserProfileDB).filter(UserProfileDB.user_id == db_user.id).first()
    if not profile:
        return {} # Empty profile
    return {
        "first_name": profile.first_name,
        "last_name": profile.last_name,
        "phone": profile.phone,
        "bio": profile.bio,
        "profile_picture_url": profile.profile_picture_url
    }

@app.put("/api/profile")
def update_profile(data: ProfileSchema, user: str = Depends(get_current_user), db: Session = Depends(get_db)):
    db_user = db.query(UserDB).filter(UserDB.username == user).first()
    if not db_user:
        raise HTTPException(404, detail="ไม่พบผู้ใช้งาน")
        
    profile = db.query(UserProfileDB).filter(UserProfileDB.user_id == db_user.id).first()
    if not profile:
        profile = UserProfileDB(user_id=db_user.id)
        db.add(profile)
        
    if data.first_name is not None: profile.first_name = data.first_name
    if data.last_name is not None: profile.last_name = data.last_name
    if data.phone is not None: profile.phone = data.phone
    if data.bio is not None: profile.bio = data.bio
    if data.profile_picture_url is not None: profile.profile_picture_url = data.profile_picture_url
    
    db.commit()
    return {"message": "บันทึกโปรไฟล์เรียบร้อยแล้ว"}

@app.get("/api/prompts")
def get_prompts(user: str = Depends(get_current_user), db: Session = Depends(get_db)):
    db_user = db.query(UserDB).filter(UserDB.username == user).first()
    if not db_user:
        raise HTTPException(404, detail="ไม่พบผู้ใช้งาน")
        
    prompts = db.query(UserPromptDB).filter(UserPromptDB.user_id == db_user.id).first()
    if not prompts:
        return {}
    return {
        "symptom_prompt": prompts.symptom_prompt,
        "vision_prompt": prompts.vision_prompt
    }

@app.put("/api/prompts")
def update_prompts(data: PromptsSchema, user: str = Depends(get_current_user), db: Session = Depends(get_db)):
    db_user = db.query(UserDB).filter(UserDB.username == user).first()
    if not db_user:
        raise HTTPException(404, detail="ไม่พบผู้ใช้งาน")
        
    prompts = db.query(UserPromptDB).filter(UserPromptDB.user_id == db_user.id).first()
    if not prompts:
        prompts = UserPromptDB(user_id=db_user.id)
        db.add(prompts)
        
    if data.symptom_prompt is not None: prompts.symptom_prompt = data.symptom_prompt
    if data.vision_prompt is not None: prompts.vision_prompt = data.vision_prompt
    
    db.commit()
    return {"message": "บันทึก Prompt เรียบร้อยแล้ว"}

@app.post("/api/chats")
def create_chat(chat: ChatSchema, user: str = Depends(get_current_user), db: Session = Depends(get_db)):
    chat_dict = chat.dict()
    msgs = chat_dict['messages'] 
    
    db_user = db.query(UserDB).filter(UserDB.username == user).first()
    
    existing = db.query(ChatDB).filter(ChatDB.id == chat.id, ChatDB.owner == user).first()
    if existing:
        raise HTTPException(400, detail="แชทนี้มีอยู่แล้ว")
        
    # Extract images and summary
    summary_text = None
    images_to_save = []
    
    for msg in msgs:
        if msg.get('role') == 'user' and msg.get('images'):
            for img in msg.get('images'):
                images_to_save.append(img)
            # Optional: Remove images from messages JSON to save space in chats table
            # msg['images'] = [] 
            
        if msg.get('role') == 'assistant' and "---สิ้นสุดการซักประวัติ---" in msg.get('content', ''):
            parts = msg['content'].split("---สิ้นสุดการซักประวัติ---")
            if len(parts) > 1: summary_text = parts[1].strip()

    new_chat = ChatDB(
        id=chat.id, 
        owner=user, 
        title=chat.title, 
        type=chat.type, 
        messages=msgs, 
        summary=summary_text,
        patient_id=chat.patient_id
    )
    db.add(new_chat)
    
    # Save Images
    for img_url in images_to_save:
        db.add(ChatImageDB(chat_id=chat.id, image_url=img_url))
        
    if db_user: db.add(AuditLogDB(user_id=db_user.id, action=f"CREATE_CHAT:{chat.id}"))
    db.commit()
    return {"status": "created"}

@app.put("/api/chats/{chat_id}")
def update_chat(chat_id: str, chat: ChatSchema, user: str = Depends(get_current_user), db: Session = Depends(get_db)):
    chat_dict = chat.dict()
    msgs = chat_dict['messages'] 
    
    existing = db.query(ChatDB).filter(ChatDB.id == chat_id, ChatDB.owner == user).first()
    if not existing:
        raise HTTPException(404, detail="ไม่พบแชท")
        
    summary_text = existing.summary
    images_to_save = []
    
    for msg in msgs:
        # Check newly added images
        if msg.get('role') == 'user' and msg.get('images'):
            for img in msg.get('images'):
                # Avoid duplicates manually or just insert (assuming unique images sent per logic)
                # To be perfectly clean, we could delete old and re-insert, but append is safer for now
                existing_img = db.query(ChatImageDB).filter(ChatImageDB.chat_id == chat_id, ChatImageDB.image_url == img).first()
                if not existing_img:
                    images_to_save.append(img)
                    
        if msg.get('role') == 'assistant' and "---สิ้นสุดการซักประวัติ---" in msg.get('content', ''):
            parts = msg['content'].split("---สิ้นสุดการซักประวัติ---")
            if len(parts) > 1: summary_text = parts[1].strip()
            
    existing.summary = summary_text
    existing.messages = msgs
    existing.title = chat.title
    if chat.patient_id is not None: existing.patient_id = chat.patient_id
    existing.timestamp = datetime.utcnow()
    
    for img_url in images_to_save:
        db.add(ChatImageDB(chat_id=chat_id, image_url=img_url))
        
    db_user = db.query(UserDB).filter(UserDB.username == user).first()
    if db_user: db.add(AuditLogDB(user_id=db_user.id, action=f"UPDATE_CHAT:{chat_id}"))
    
    db.commit()
    return {"status": "updated"}

@app.get("/api/chats")
def get_chats(user: str = Depends(get_current_user), db: Session = Depends(get_db)):
    chats = db.query(ChatDB).filter(ChatDB.owner == user).order_by(ChatDB.timestamp.desc()).all()
    result = {}
    for c in chats:
        result[c.id] = {
            "id": c.id, 
            "title": c.title, 
            "type": c.type, 
            "messages": [], # Empty list to save payload size initially
            "timestamp": c.timestamp.isoformat() if c.timestamp else None
        }
    return result

@app.get("/api/chats/{chat_id}")
def get_single_chat(chat_id: str, user: str = Depends(get_current_user), db: Session = Depends(get_db)):
    c = db.query(ChatDB).filter(ChatDB.id == chat_id, ChatDB.owner == user).first()
    if not c:
        raise HTTPException(404, detail="ไม่พบแชท")
    return {
        "id": c.id, 
        "title": c.title, 
        "type": c.type, 
        "summary": c.summary,
        "messages": c.messages, 
        "timestamp": c.timestamp.isoformat() if c.timestamp else None
    }

@app.delete("/api/chats/{chat_id}")
def delete_chat(chat_id: str, user: str = Depends(get_current_user), db: Session = Depends(get_db)):
    db.query(ChatDB).filter(ChatDB.id == chat_id, ChatDB.owner == user).delete()
    db.query(ChatImageDB).filter(ChatImageDB.chat_id == chat_id).delete()
    
    db_user = db.query(UserDB).filter(UserDB.username == user).first()
    if db_user: db.add(AuditLogDB(user_id=db_user.id, action=f"DELETE_CHAT:{chat_id}"))
    
    db.commit()
    return {"status": "deleted"}

# --- 🔥 Ollama Connection 🔥 ---
@app.post("/api/chat")
async def chat_with_ollama(request: OllamaRequest):
    # เชื่อมต่อกับ Ollama ที่รันในเครื่อง (Port 11434)
    OLLAMA_URL = "http://localhost:11434/api/chat"
    
    try:
        # Timeout นานๆ เผื่อเครื่องประมวลผลช้า
        async with httpx.AsyncClient(timeout=120.0) as client:
            print(f"[Info] กำลังส่งข้อมูลไป Ollama Model: {request.model}")
            
            response = await client.post(
                OLLAMA_URL, 
                json=request.dict()
            )
            response.raise_for_status()
            return response.json()
            
    except Exception as e:
        print(f"[Error] Error connecting to Ollama: {e}")
        raise HTTPException(status_code=500, detail=f"Ollama Error: เชื่อมต่อ AI ไม่ได้ (กรุณาเช็คว่าเปิด Ollama หรือยัง?)")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)