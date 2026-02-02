# Account App - Backend API Documentation

## Base URL
```
http://localhost:5000/api
```

---

## Authentication Routes

### 1. Google Sign-In
**Endpoint:** `POST /auth/google-signin`

**Description:** Authenticate user with Google. Creates new user if first time, returns existing user if already registered.

**Request Body:**
```json
{
  "idToken": "firebase_id_token_from_client"
}
```

**Response (New User):**
```json
{
  "success": true,
  "setupComplete": false,
  "user": {
    "id": "mongodb_user_id",
    "firebaseUid": "firebase_uid",
    "email": "user@gmail.com",
    "displayName": "User Name",
    "photoURL": "https://photo-url.com/photo.jpg",
    "username": null,
    "balance": 0,
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

**Response (Returning User):**
```json
{
  "success": true,
  "setupComplete": true,
  "user": {
    "id": "mongodb_user_id",
    "firebaseUid": "firebase_uid",
    "email": "user@gmail.com",
    "displayName": "User Name",
    "photoURL": "https://photo-url.com/photo.jpg",
    "username": "john_doe",
    "balance": 1000,
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

---

### 2. Check Username Availability
**Endpoint:** `POST /auth/check-username`

**Description:** Check if username is available. Returns suggestions if taken.

**Request Body:**
```json
{
  "username": "john"
}
```

**Response (Available):**
```json
{
  "success": true,
  "available": true
}
```

**Response (Taken - with suggestions):**
```json
{
  "success": true,
  "available": false,
  "suggestions": [
    "john_123",
    "john.official",
    "john-2025",
    "john_user"
  ]
}
```

**Response (Invalid Format):**
```json
{
  "success": false,
  "message": "Username can only contain letters, numbers, dots, hyphens, and underscores"
}
```

---

### 3. Complete Setup
**Endpoint:** `POST /auth/complete-setup`

**Description:** Set username and password after Google sign-in.

**Request Body:**
```json
{
  "firebaseUid": "firebase_uid",
  "username": "john_doe",
  "password": "securePassword123"
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "Setup completed successfully",
  "user": {
    "id": "mongodb_user_id",
    "firebaseUid": "firebase_uid",
    "username": "john_doe",
    "email": "user@gmail.com",
    "displayName": "User Name",
    "photoURL": "https://photo-url.com/photo.jpg",
    "balance": 0
  }
}
```

**Response (Username Taken):**
```json
{
  "success": false,
  "message": "Username already taken",
  "suggestions": [
    "johndoe_123",
    "johndoe.official",
    "johndoe-2025",
    "johndoe_user"
  ]
}
```

---

### 4. Username/Password Login
**Endpoint:** `POST /auth/login`

**Description:** Login with username and password.

**Request Body:**
```json
{
  "username": "john_doe",
  "password": "securePassword123"
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "Login successful",
  "user": {
    "id": "mongodb_user_id",
    "firebaseUid": "firebase_uid",
    "username": "john_doe",
    "email": "user@gmail.com",
    "displayName": "User Name",
    "photoURL": "https://photo-url.com/photo.jpg",
    "balance": 1000,
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

**Response (Invalid Credentials):**
```json
{
  "success": false,
  "message": "Invalid username or password"
}
```

**Response (Setup Not Complete):**
```json
{
  "success": false,
  "message": "Please complete setup first using Google Sign-In"
}
```

---

### 5. Get User Details
**Endpoint:** `GET /auth/user`

**Description:** Get current user details (requires Firebase ID token).

**Headers:**
```
Authorization: Bearer <firebase_id_token>
```

**Response:**
```json
{
  "success": true,
  "user": {
    "id": "mongodb_user_id",
    "firebaseUid": "firebase_uid",
    "username": "john_doe",
    "email": "user@gmail.com",
    "displayName": "User Name",
    "photoURL": "https://photo-url.com/photo.jpg",
    "balance": 1000,
    "setupComplete": true,
    "googleDriveConnected": true,
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

---

### 6. Logout
**Endpoint:** `POST /auth/logout`

**Description:** Logout user (requires Firebase ID token).

**Headers:**
```
Authorization: Bearer <firebase_id_token>
```

**Response:**
```json
{
  "success": true,
  "message": "Logout successful"
}
```

---

## Username Validation Rules

### Allowed Characters:
- Lowercase letters (a-z)
- Uppercase letters (A-Z) - stored as lowercase
- Numbers (0-9)
- Dot (.)
- Hyphen (-)
- Underscore (_)

### Not Allowed:
- Spaces
- @ symbol
- Special characters (!@#$%^&*)

### Case Insensitive:
- `JOHN_DOE`, `john_doe`, `John_Doe` → All stored as `john_doe`
- Login works with any case variation

### Examples:
✅ `john_doe`
✅ `john.123`
✅ `john-official`
✅ `JOHN_DOE` (stored as `john_doe`)
❌ `john doe` (space not allowed)
❌ `john@123` (@ not allowed)

---

## Error Handling

All errors follow this format:
```json
{
  "success": false,
  "message": "Error description",
  "error": "Technical error details (optional)"
}
```

Common HTTP Status Codes:
- `200` - Success
- `400` - Bad Request (invalid input)
- `401` - Unauthorized (invalid credentials/token)
- `404` - Not Found (user doesn't exist)
- `500` - Server Error
