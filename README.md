# 💰 Financial Management System

A **complete financial management system for congregations and groups**, designed to handle deposits, withdrawals, transfers, balance control, and monthly archiving with strong access control.

This project was built to solve real-world financial organization problems, supporting **multiple users, multiple congregations, and multiple groups**, with clear separation of permissions between administrators and regular users.

---

## 🚀 Features

### 👤 Authentication & Authorization

* Secure authentication using **JWT**
* Role-based access control (**Admin** and **User**)
* Each user can only access their own congregation and groups

### 🏦 Financial Operations

* Deposits, withdrawals, and transfers between groups
* Automatic balance calculation
* Transaction history with:

  * Date and time
  * Transaction type
  * Amount
  * Responsible person
  * Destination group

### 📊 Group & Congregation Structure

* Multiple congregations (e.g., Headquarters, Canoas, Novo Porto)
* Each congregation contains multiple groups (Children, Youth, Men, Women, General Cash)
* Each group has its own independent balance

### 📁 Monthly Archiving

* Monthly financial archiving
* Balance reset after archiving
* Archived history available for consultation
* Prevents old transactions from affecting new balances

### 🛠 Admin Features

* View all congregations and groups
* Create users and groups
* View total balances
* Archive monthly data
* Paginated transaction history

### 💻 User Features

* View balances and transaction history
* Perform deposits and withdrawals
* Transfer values between groups

---

## 🧱 Tech Stack

### Backend

* **Node.js**
* **Express.js**
* **MySQL**
* **JWT Authentication**
* RESTful API architecture

### Frontend

* **React**
* **Bootstrap**
* Local state management

### Database

* MySQL with:

  * Relational structure
  * Stored procedures
  * Triggers for balance updates

---

## 🗂 Database Highlights

* Automatic creation of system groups (e.g., *General Cash*)
* Optimized indexes for transaction queries
* Stored procedures for monthly archiving
* Triggers to ensure balance consistency

---

## 📂 Project Structure

```text
backend/
 ├── controllers/
 ├── routes/
 ├── middlewares/
 ├── services/
 ├── database/
 └── server.js

frontend/
 ├── components/
 ├── pages/
 ├── services/
 └── App.jsx
```

---

## ⚙️ How to Run Locally

### Backend

```bash
npm install
npm run dev
```

### Frontend

```bash
npm install
npm start
```

---

## 🔐 Environment Variables

```env
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=yourpassword
DB_NAME=financial_system
JWT_SECRET=your_secret_key
```

---

## 🎯 Project Purpose

This project was developed as a **real-world fullstack application**, focusing on:

* Business logic
* Security
* Data integrity
* Scalability

It demonstrates the ability to design and implement **complete systems from scratch**, covering backend, frontend, and database layers.

---

## 👨‍💻 Author

**Athus Kuntler**
Junior Fullstack Developer

* GitHub: [https://github.com/AthusKuntler](https://github.com/AthusKuntler)
* LinkedIn: [https://www.linkedin.com/in/athus-kuntler-9a5238266/](https://www.linkedin.com/in/athus-kuntler-9a5238266/)

---

## 📌 Status

🚧 Actively improving and refactoring

Contributions, feedback, and suggestions are welcome!
