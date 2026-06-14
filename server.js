require('dotenv').config(); 
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const JWT_SECRET = process.env.JWT_SECRET || 'dice_game_secret_key_123';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'Lazysecurity';

mongoose.connect(process.env.MONGO_URI).then(async () => {
    console.log('✅ MongoDB Connected!');
    const superAdminExists = await Admin.findOne({ role: 'superadmin' });
    if (!superAdminExists) {
      const hash = await bcrypt.hash(ADMIN_SECRET, 10);
      await Admin.create({ username: 'superadmin', password: hash, role: 'superadmin' });
    }
    const settingsExist = await Settings.findOne();
    if (!settingsExist) await Settings.create({ kpay: '09450000000', wave: '09450000000', winRate: 42 }); 
}).catch(err => console.log('❌ DB Error:', err));

const User = mongoose.model('User', new mongoose.Schema({ phone: { type: String, required: true, unique: true }, username: String, password: { type: String, required: true }, balance: { type: Number, default: 5000 } }));
const BetHistory = mongoose.model('BetHistory', new mongoose.Schema({ phone: String, betType: String, amount: Number, result: String, payout: Number, createdAt: { type: Date, default: Date.now } }));
const Transaction = mongoose.model('Transaction', new mongoose.Schema({ phone: String, type: String, amount: Number, method: String, accountPhone: String, accountName: String, screenshot: String, status: { type: String, default: 'pending' }, createdAt: { type: Date, default: Date.now } }));
const Admin = mongoose.model('Admin', new mongoose.Schema({ username: { type: String, required: true, unique: true }, password: { type: String, required: true }, role: { type: String, enum: ['superadmin', 'subadmin'], default: 'subadmin' } }));
const Settings = mongoose.model('Settings', new mongoose.Schema({ kpay: { type: String, default: '09450000000' }, wave: { type: String, default: '09450000000' }, winRate: { type: Number, default: 42 } }));

let userPhones = {}; 
let playerStats = {}; 
const activeBets = new Set(); 

const getNewPityTarget = () => Math.floor(Math.random() * 5) + 4; 
const getNewEqualPityTarget = () => Math.floor(Math.random() * 8) + 8; 

const getRiggedSinglePlayerDice = (betType, winProbability) => {
  const isWin = Math.random() < winProbability;
  let targetTotal;
  if (isWin) {
    if (betType === 'under') targetTotal = Math.floor(Math.random() * 5) + 2; 
    else if (betType === 'over') targetTotal = Math.floor(Math.random() * 5) + 8; 
    else targetTotal = 7; 
  } else {
    if (betType === 'under') targetTotal = Math.floor(Math.random() * 6) + 7; 
    else if (betType === 'over') targetTotal = Math.floor(Math.random() * 6) + 2; 
    else targetTotal = Math.random() > 0.5 ? Math.floor(Math.random() * 5) + 2 : Math.floor(Math.random() * 5) + 8; 
  }
  let d1, d2;
  do { d1 = Math.floor(Math.random() * 6) + 1; d2 = targetTotal - d1; } while (d2 < 1 || d2 > 6);
  return { dice1: d1, dice2: d2, total: targetTotal };
};

io.on('connection', async (socket) => {
  const token = socket.handshake.query.token;
  if (!token) return socket.disconnect(); 
  
  let currentSocketPhone = null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    currentSocketPhone = decoded.phone;
    let dbUser = await User.findOne({ phone: currentSocketPhone });
    if (!dbUser) return socket.disconnect(); 
    
    userPhones[socket.id] = currentSocketPhone; 
    socket.emit('balanceUpdate', dbUser.balance);
  } catch (err) { return socket.disconnect(); }

  socket.on('playSolo', async (data) => {
    const activePhone = userPhones[socket.id];
    if (!activePhone) return socket.emit('errorMsg', 'Error: Session သက်တမ်းကုန်သွားပါပြီ!');

    if (activeBets.has(activePhone)) return socket.emit('errorMsg', 'ဖြည်းဖြည်းချင်း လောင်းပါ!');
    activeBets.add(activePhone);

    try {
      const betAmount = Number(data.amount);
      if (betAmount > 100000) return socket.emit('errorMsg', 'အများဆုံး ၁ သိန်းသာ လောင်းနိုင်ပါသည်!');

      let u = await User.findOne({ phone: activePhone });

      if (u && u.balance >= betAmount && betAmount > 0) {
        let preBetBalance = u.balance; 
        u.balance -= betAmount; 
        
        let pStat = playerStats[activePhone];
        if (!pStat) { 
          pStat = { losses: 0, equalLosses: 0, pityTarget: getNewPityTarget(), equalPityTarget: getNewEqualPityTarget(), lastBet: betAmount, baseCapital: preBetBalance, isLucky: (Math.random() < 0.05) }; 
          playerStats[activePhone] = pStat; 
        }

        if (betAmount !== pStat.lastBet) {
          pStat.losses = 0; pStat.equalLosses = 0; 
          pStat.pityTarget = getNewPityTarget(); pStat.equalPityTarget = getNewEqualPityTarget(); 
          pStat.lastBet = betAmount;
        }

        let base = pStat.baseCapital;
        const potentialWinAmount = Math.round(data.type === 'equal' ? betAmount * 5.8 : betAmount * 2.3);
        const futureBalance = u.balance + potentialWinAmount;

        let ceiling;
        if (pStat.isLucky) {
          if (base <= 10000) ceiling = base * 10; 
          else if (base <= 50000) ceiling = base + 100000; 
          else ceiling = base + 200000; 
        } else {
          let allowedProfit = base < 50000 ? base : 50000; 
          ceiling = base + allowedProfit;
        }

        let probability = 0.38; 

        if (futureBalance >= ceiling) probability = 0.23; 
        else if (futureBalance >= ceiling * 0.8) probability = 0.33; 
        else if (futureBalance >= base * 1.5) probability = 0.38; 
        else if (futureBalance >= base * 0.5) probability = 0.46; 
        else probability = 0.48; 

        if (data.type === 'equal') {
          probability = 0.15; 
          if (futureBalance >= ceiling) probability = 0.02; 
          if (pStat.equalLosses >= pStat.equalPityTarget) { 
            probability = 1.0; 
            if (futureBalance >= ceiling) probability = 0.18; 
          }
        } else {
          if (pStat.losses >= pStat.pityTarget) { 
            probability = 1.3; 
            if (futureBalance >= ceiling) probability = 0.30; 
          }
        }

        const result = getRiggedSinglePlayerDice(data.type, probability); 
        const total = result.total;
        let winningType = total < 7 ? 'under' : total > 7 ? 'over' : 'equal';
        
        let winAmount = 0; let status = 'lose';

        if (winningType === data.type) {
          status = 'win'; winAmount = potentialWinAmount; u.balance += winAmount;
          if (data.type === 'equal') { pStat.equalLosses = 0; pStat.equalPityTarget = getNewEqualPityTarget(); } else { pStat.losses = 0; pStat.pityTarget = getNewPityTarget(); }
        } else {
          if (data.type === 'equal') pStat.equalLosses += 1; else pStat.losses += 1;
        }

        await u.save();
        
        // 🚨 ဤနေရာတွင် မှတ်တမ်း (BetHistory) အသစ် သိမ်းမည့် Code ပြန်ထည့်ထားပါသည် 🚨
        await BetHistory.create({ phone: u.phone, betType: data.type, amount: betAmount, result: status, payout: winAmount });
        
        socket.emit('soloResult', { dice: result, status, amountWon: winAmount, newBalance: u.balance });
        socket.emit('balanceUpdate', u.balance); 
        io.emit('userUpdate'); 
      } else {
        socket.emit('errorMsg', 'Balance မလောက်ပါ!');
      }
    } finally {
      activeBets.delete(activePhone); 
    }
  });
  
  socket.on('disconnect', () => { delete userPhones[socket.id]; });
});

app.post('/api/signup', async (req, res) => { const { phone, username, password } = req.body; try { const userExists = await User.findOne({ phone }); if (userExists) return res.status(400).json({ error: 'အကောင့်ရှိပြီးသားပါ' }); const hash = await bcrypt.hash(password, 10); const newUser = await User.create({ phone, username, password: hash, balance: 5000 }); const token = jwt.sign({ phone: newUser.phone, username: newUser.username }, JWT_SECRET); res.json({ message: 'Success', token, phone: newUser.phone, username: newUser.username, balance: newUser.balance }); } catch (e) { res.status(500).json({ error: 'Server error' }); }});
app.post('/api/login', async (req, res) => { const { phone, password } = req.body; try { const user = await User.findOne({ phone }); if (!user) return res.status(400).json({ error: 'အချက်အလက် မှားယွင်းနေပါသည်' }); const isMatch = await bcrypt.compare(password, user.password); if (!isMatch) return res.status(400).json({ error: 'အချက်အလက် မှားယွင်းနေပါသည်' }); const token = jwt.sign({ phone: user.phone, username: user.username }, JWT_SECRET); res.json({ message: 'Success', token, phone: user.phone, username: user.username, balance: user.balance }); } catch (e) { res.status(500).json({ error: 'Server error' }); }});
app.post('/api/profile/update', async (req, res) => { const { currentPhone, newPhone, newUsername } = req.body; try { if (currentPhone !== newPhone) { const phoneExists = await User.findOne({ phone: newPhone }); if (phoneExists) return res.status(400).json({ error: 'ဒီဖုန်းနံပါတ် သုံးပြီးပါပြီ' }); } const u = await User.findOneAndUpdate( { phone: currentPhone }, { phone: newPhone, username: newUsername }, { new: true } ); if (currentPhone !== newPhone) { await BetHistory.updateMany({ phone: currentPhone }, { phone: newPhone }); await Transaction.updateMany({ phone: currentPhone }, { phone: newPhone }); } res.json({ message: 'Success', phone: u.phone, username: u.username }); } catch (e) { res.status(500).json({ error: 'Server error' }); }});

app.post('/api/deposit', async (req, res) => { 
  try { 
    const amountNum = Number(req.body.amount);
    if (isNaN(amountNum) || amountNum <= 0) return res.status(400).json({ error: 'ပမာဏ မှားယွင်းနေပါသည်' });
    await Transaction.create({ phone: req.body.phone, type: 'deposit', amount: amountNum, screenshot: req.body.screenshot, status: 'pending' }); 
    io.emit('newTransaction'); 
    res.json({ message: 'Deposit requested successfully' }); 
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/withdraw', async (req, res) => { 
  const { phone, amount, method, accountPhone, accountName } = req.body; 
  try { 
    const u = await User.findOne({ phone }); 
    if (!u || u.balance < Number(amount)) return res.status(400).json({ error: 'Balance မလောက်ပါ' }); 

    const [depAgg, betAgg] = await Promise.all([
      Transaction.aggregate([{ $match: { phone, type: 'deposit', status: 'approved' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      BetHistory.aggregate([{ $match: { phone } }, { $group: { _id: null, total: { $sum: '$amount' } } }])
    ]);
    const totalDep = depAgg.length > 0 ? depAgg[0].total : 0;
    const totalBet = betAgg.length > 0 ? betAgg[0].total : 0;

    if (totalDep === 0) return res.status(400).json({ error: 'ငွေထုတ်ရန်အတွက် အနည်းဆုံး တစ်ကြိမ် ငွေသွင်းဖူးရန် လိုအပ်ပါသည်!' });
    if (totalBet < totalDep) return res.status(400).json({ error: `Turnover မပြည့်သေးပါ။ သင်သွင်းထားသော ${totalDep.toLocaleString()} Ks ပြည့်အောင် ဆော့ပါ။` });

    u.balance -= Number(amount); 
    await u.save(); 
    
    if (playerStats[phone]) playerStats[phone].isLucky = undefined;

    const targetSocketId = Object.keys(userPhones).find(key => userPhones[key] === phone); 
    if (targetSocketId) { io.to(targetSocketId).emit('balanceUpdate', u.balance); } 
    
    await Transaction.create({ phone, type: 'withdraw', amount: Number(amount), method, accountPhone, accountName, status: 'pending' }); 
    io.emit('newTransaction'); 
    res.json({ message: 'Withdraw requested successfully' }); 
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/history/bets/:phone', async (req, res) => { try { const bets = await BetHistory.find({ phone: req.params.phone }).sort({ createdAt: -1 }).limit(50); res.json(bets); } catch(e) { res.status(500).json({error: 'Server error'}); } });
app.get('/api/history/transactions/:phone', async (req, res) => { try { const txs = await Transaction.find({ phone: req.params.phone }).sort({ createdAt: -1 }).limit(50); res.json(txs); } catch(e) { res.status(500).json({error: 'Server error'}); } });
app.get('/api/settings', async (req, res) => { const set = await Settings.findOne(); res.json(set || { kpay: '', wave: '', winRate: 42 }); });

const verifyAdmin = (req, res, next) => { const token = req.headers.authorization?.split(' ')[1]; if(!token) return res.status(401).json({error: "Admin Token လိုအပ်ပါသည်"}); try { const decoded = jwt.verify(token, JWT_SECRET); if(!decoded.role) return res.status(403).json({error: "Admin မဟုတ်ပါ"}); req.admin = decoded; next(); } catch(e) { res.status(401).json({error: "Token သက်တမ်းကုန်သွားပါပြီ"}); }};
const isSuperAdmin = (req, res, next) => { if(req.admin.role !== 'superadmin') return res.status(403).json({error: "Superadmin သာလျှင် လုပ်ခွင့်ရှိပါသည်!"}); next(); };

app.post('/api/admin/login', async (req, res) => { const { username, password } = req.body; try { const admin = await Admin.findOne({ username }); if (!admin) return res.status(400).json({ error: 'Username သို့မဟုတ် Password မှားနေပါသည်' }); const isMatch = await bcrypt.compare(password, admin.password); if (!isMatch) return res.status(400).json({ error: 'Username သို့မဟုတ် Password မှားနေပါသည်' }); const token = jwt.sign({ id: admin._id, username: admin.username, role: admin.role }, JWT_SECRET, { expiresIn: '1d' }); res.json({ message: 'Login Success', token, username: admin.username, role: admin.role }); } catch (e) { res.status(500).json({ error: 'Server Error' }); }});

app.get('/api/admin/dashboard', verifyAdmin, async (req, res) => { 
  try { 
    const totalUsers = await User.countDocuments(); const pendingTxCount = await Transaction.countDocuments({ status: 'pending' }); const totalBets = await BetHistory.countDocuments(); 
    const now = new Date(); const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()); const startOfWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); 
    const getSum = async (txType, fromDate) => { const result = await Transaction.aggregate([{ $match: { type: txType, status: 'approved', createdAt: { $gte: fromDate } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]); return result.length > 0 ? result[0].total : 0; };
    const todayDeposit = await getSum('deposit', startOfToday); const todayWithdraw = await getSum('withdraw', startOfToday); const weekDeposit = await getSum('deposit', startOfWeek); const weekWithdraw = await getSum('withdraw', startOfWeek);
    res.json({ totalUsers, pendingTxCount, totalBets, todayDeposit, todayWithdraw, weekDeposit, weekWithdraw }); 
  } catch(e) { res.status(500).json({error: 'Error'}); }
});

app.get('/api/admin/transactions', verifyAdmin, async (req, res) => { 
  try { 
    const txs = await Transaction.aggregate([
      { $sort: { createdAt: -1 } },
      { $limit: 300 },
      { $lookup: { from: 'users', localField: 'phone', foreignField: 'phone', as: 'userInfo' } },
      { $unwind: { path: '$userInfo', preserveNullAndEmptyArrays: true } },
      { $project: { phone: 1, type: 1, amount: 1, status: 1, createdAt: 1, method: 1, accountPhone: 1, accountName: 1, screenshot: 1, username: '$userInfo.username' } }
    ]);
    res.json(txs); 
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/transaction/action', verifyAdmin, async (req, res) => { 
  const { transactionId, action } = req.body; 
  try { 
    const tx = await Transaction.findById(transactionId); 
    if (!tx || tx.status !== 'pending') return res.status(400).json({ error: 'Transaction handles match error' }); 
    
    tx.status = action === 'approve' ? 'approved' : 'rejected'; 
    await tx.save(); 
    
    let u = await User.findOne({ phone: tx.phone }); 
    if (u) {
      if (tx.type === 'deposit' && action === 'approve') { 
        u.balance += Number(tx.amount); 
        if (playerStats[tx.phone]) playerStats[tx.phone].baseCapital = u.balance;
      } else if (tx.type === 'withdraw' && action === 'reject') { 
        u.balance += Number(tx.amount); 
      } 
      await u.save(); 
      
      const targetSocketId = Object.keys(userPhones).find(key => userPhones[key] === tx.phone); 
      if (targetSocketId) { 
        io.to(targetSocketId).emit('balanceUpdate', u.balance); 
        io.to(targetSocketId).emit('txUpdate', { type: tx.type, status: tx.status, amount: tx.amount }); 
      } 
    }
    
    io.emit('userUpdate'); 
    res.json({ message: `Transaction ${action}d successfully` }); 
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/settings', verifyAdmin, async (req, res) => { const { kpay, wave, winRate } = req.body; try { let set = await Settings.findOne(); if (set) { set.kpay = kpay; set.wave = wave; if(winRate !== undefined) set.winRate = Number(winRate); await set.save(); } res.json({ message: 'Settings Updated', settings: set }); } catch(e) { res.status(500).json({error: 'Error'}); }});
app.get('/api/admin/users', verifyAdmin, async (req, res) => { try { const allUsers = await User.find().select('-password').sort({ balance: -1 }); res.json(allUsers); } catch(e) { res.status(500).json({error: 'Error'}); }});
app.delete('/api/admin/users/:id', verifyAdmin, async (req, res) => { try { await User.findByIdAndDelete(req.params.id); res.json({ message: 'အကောင့်ကို ဖျက်ပစ်လိုက်ပါပြီ' }); } catch(e) { res.status(500).json({error: 'Error'}); }});

app.post('/api/admin/users/update-balance', verifyAdmin, async (req, res) => { 
  const { phone, newBalance } = req.body; 
  try { 
    const u = await User.findOne({ phone }); 
    if(!u) return res.status(404).json({error: "User not found"});
    
    const parsedBalance = Number(newBalance);
    if (isNaN(parsedBalance)) return res.status(400).json({error: "Invalid Number"});

    const oldBalance = u.balance; 
    const diff = parsedBalance - oldBalance; 
    u.balance = parsedBalance; 
    await u.save(); 
    
    if (diff > 0) {
      await Transaction.create({ phone: u.phone, type: 'deposit', amount: diff, method: 'Manual_Admin', accountPhone: 'Admin', accountName: 'System', status: 'approved', createdAt: new Date() });
      io.emit('newTransaction'); 
    }
    
    if (playerStats[phone]) playerStats[phone].baseCapital = u.balance;

    const targetSocketId = Object.keys(userPhones).find(key => userPhones[key] === phone); 
    if (targetSocketId) { io.to(targetSocketId).emit('balanceUpdate', u.balance); } 
    
    io.emit('userUpdate'); 
    res.json({ message: 'Balance Updated', user: u }); 
  } catch(e) { res.status(500).json({error: 'Error'}); }
});

app.get('/api/admin/subadmins', verifyAdmin, isSuperAdmin, async (req, res) => { try { const subAdmins = await Admin.find({ role: 'subadmin' }).select('-password'); res.json(subAdmins); } catch(e) { res.status(500).json({error: 'Error'}); }});
app.post('/api/admin/create-subadmin', verifyAdmin, isSuperAdmin, async (req, res) => { const { username, password } = req.body; try { const exists = await Admin.findOne({username}); if(exists) return res.status(400).json({error: 'Username ရှိပြီးသားပါ'}); const hash = await bcrypt.hash(password, 10); await Admin.create({ username, password: hash, role: 'subadmin' }); res.json({ message: 'Subadmin Account အသစ် ဖန်တီးပြီးပါပြီ' }); } catch(e) { res.status(500).json({error: 'Error'}); }});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));