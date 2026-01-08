# Account App Backend

## Setup Instructions

### 1. Install Dependencies
```bash
cd backend
npm install
```

### 2. Configure Environment Variables
Edit `.env` file and add your MongoDB connection string:
```
PORT=5000
MONGODB_URI=your_mongodb_atlas_connection_string
NODE_ENV=development
```

### 3. MongoDB Setup (If not done)
1. Go to https://www.mongodb.com/cloud/atlas
2. Create a free cluster
3. Create a database user
4. Whitelist your IP (or use 0.0.0.0/0 for all IPs)
5. Get connection string and paste in `.env` file

### 4. Run the Server
```bash
npm run dev
```

Server will run on `http://localhost:5000`

## API Endpoints

### Authentication Routes

#### 1. Google Sign-In
- **URL:** `POST /api/auth/google-signin`
- **Body:**
  ```json
  {
    "idToken": "firebase_id_token_from_client"
  }
  ```
- **Response:**
  ```json
  {
    "success": true,
    "message": "Login successful",
    "user": {
      "id": "mongodb_user_id",
      "firebaseUid": "firebase_uid",
      "email": "user@example.com",
      "displayName": "User Name",
      "photoURL": "photo_url",
      "balance": 0
    }
  }
  ```

#### 2. Get User Details
- **URL:** `GET /api/auth/user`
- **Headers:**
  ```
  Authorization: Bearer <firebase_id_token>
  ```
- **Response:**
  ```json
  {
    "success": true,
    "user": {
      "id": "mongodb_user_id",
      "email": "user@example.com",
      "displayName": "User Name",
      "balance": 0
    }
  }
  ```

#### 3. Logout
- **URL:** `POST /api/auth/logout`
- **Headers:**
  ```
  Authorization: Bearer <firebase_id_token>
  ```
- **Response:**
  ```json
  {
    "success": true,
    "message": "Logout successful"
  }
  ```

## Folder Structure
```
backend/
├── config/
│   ├── firebase.js       # Firebase Admin SDK setup
│   └── database.js       # MongoDB connection
├── models/
│   └── User.js           # User schema
├── routes/
│   └── auth.js           # Authentication routes
├── middleware/
│   └── authMiddleware.js # Token verification
├── .env                  # Environment variables
├── .gitignore
├── package.json
├── server.js             # Main server file
└── serviceAccountKey.json # Firebase service account
```
