require('dotenv').config(); 
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- ၁။ MongoDB Database ချိတ်ဆက်ခြင်း ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected Successfully!'))
  .catch(err => console.log('❌ MongoDB Connection Error:', err));

const userSchema = new mongoose.Schema({
  userId: String, 
  balance: { type: Number, default: 10000 }
});
const User = mongoose.model('User', userSchema);

// --- ၂။ Game State ---
let timeLeft = 15;
let gameStatus = 'BETTING'; 
let betPool = { under: 0, equal: 0, over: 0 };
let currentDiceResult = { dice1: 1, dice2: 1, total: 2 };

let users = {}; // socketId -> balance
let userIds = {}; // socketId -> Database userId (Refresh လုပ်လည်း မပျောက်အောင်)
let currentRoundBets = {}; 

// --- ၃။ Rigged Dice Logic ---
const calculateRiggedResult = () => {
  const { under, equal, over } = betPool;
  if (under === 0 && equal === 0 && over === 0) {
    const dice1 = Math.floor(Math.random() * 6) + 1;
    const dice2 = Math.floor(Math.random() * 6) + 1;
    return { dice1, dice2, total: dice1 + dice2 };
  }
  let minType = 'equal'; 
  let minAmount = equal;
  if (under < minAmount) { minType = 'under'; minAmount = under; }
  if (over < minAmount) { minType = 'over'; minAmount = over; }

  let targetTotal;
  if (minType === 'under') targetTotal = Math.floor(Math.random() * 5) + 2; 
  else if (minType === 'over') targetTotal = Math.floor(Math.random() * 5) + 8; 
  else targetTotal = 7; 

  let d1, d2;
  do {
    d1 = Math.floor(Math.random() * 6) + 1;
    d2 = targetTotal - d1;
  } while (d2 < 1 || d2 > 6);
  return { dice1: d1, dice2: d2, total: targetTotal };
};

// --- ၄။ Main Game Loop ---
setInterval(async () => {
  if (gameStatus === 'BETTING') {
    timeLeft--; 
    
    if (timeLeft === 0) {
      gameStatus = 'ROLLING'; 
      console.log("Time's up! Rolling dice...");
      
      currentDiceResult = calculateRiggedResult();
      const total = currentDiceResult.total;
      
      let winningType = '';
      if (total < 7) winningType = 'under';
      else if (total > 7) winningType = 'over';
      else winningType = 'equal';

      // Payout ရှင်းခြင်း နဲ့ Database ကို Update လုပ်ခြင်း
      for (const [socketId, bet] of Object.entries(currentRoundBets)) {
        if (users[socketId] !== undefined) {
          if (bet.type === winningType) {
            let winAmount = Math.round(winningType === 'equal' ? bet.amount * 5.8 : bet.amount * 2.3); 
            users[socketId] += winAmount; 
            io.to(socketId).emit('betResult', { status: 'win', amountWon: winAmount, newBalance: users[socketId] });
          } else {
            io.to(socketId).emit('betResult', { status: 'lose', amountLost: bet.amount, newBalance: users[socketId] });
          }
          
          io.to(socketId).emit('balanceUpdate', users[socketId]);

          // DB ကို လှမ်း Update မယ် (userId သုံးပြီး)
          await User.findOneAndUpdate({ userId: userIds[socketId] }, { balance: users[socketId] });
        }
      }

      io.emit('gameUpdate', { timeLeft, gameStatus, betPool });
      io.emit('diceResult', currentDiceResult); 
      console.log(`Result: ${total} (${winningType}). DB Updated.`);
      
      setTimeout(() => {
        timeLeft = 15;
        gameStatus = 'BETTING';
        betPool = { under: 0, equal: 0, over: 0 }; 
        currentRoundBets = {}; 
        console.log("--- New Round Started ---");
      }, 5000); 
    }
  }
  
  if (gameStatus === 'BETTING') io.emit('gameUpdate', { timeLeft, gameStatus, betPool });
}, 1000); 

// --- ၅။ Socket Connection ---
io.on('connection', async (socket) => {
  
  // ** ပြင်ဆင်ချက် - React ဘက်က လှမ်းပို့မယ့် userId ကို ယူမယ်။ မပို့ရင် socket.id ကို ယာယီသုံးမယ်။ **
  const customUserId = socket.handshake.query.userId || socket.id;
  console.log(`A user connected: Socket(${socket.id}) | UserID(${customUserId})`);

  try {
    let dbUser = await User.findOne({ userId: customUserId });
    if (!dbUser) {
      dbUser = new User({ userId: customUserId, balance: 10000 });
      await dbUser.save();
    }
    users[socket.id] = dbUser.balance; 
    userIds[socket.id] = customUserId; // နောက်ပိုင်း DB Update ဖို့ မှတ်ထားမယ်
    
    socket.emit('balanceUpdate', users[socket.id]);
    socket.emit('gameUpdate', { timeLeft, gameStatus, betPool });
  } catch (err) {
    console.log("DB Error fetching user:", err);
  }

  socket.on('placeBet', async (data) => {
    if (gameStatus === 'BETTING') {
      const betAmount = data.amount;
      
      if (users[socket.id] >= betAmount) {
        users[socket.id] -= betAmount; 
        socket.emit('balanceUpdate', users[socket.id]); 

        if (!currentRoundBets[socket.id]) currentRoundBets[socket.id] = { type: data.type, amount: 0 };
        currentRoundBets[socket.id].amount += betAmount; 
        betPool[data.type] += betAmount; 

        // လောင်းကြေး ဖြတ်ပြီးတာနဲ့ DB ကို Update လုပ်မယ်
        await User.findOneAndUpdate({ userId: userIds[socket.id] }, { balance: users[socket.id] });

        io.emit('gameUpdate', { timeLeft, gameStatus, betPool });
      } else {
        socket.emit('errorMsg', 'Balance မလောက်ပါ!');
      }
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    delete users[socket.id]; 
    delete userIds[socket.id];
    delete currentRoundBets[socket.id];
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});