// Centralized translations for the resident portal
// Keys are English strings; values are translations per language code.

export const LANGUAGES = [
  { code: 'en', label: 'English', flag: '🇨🇦' },
  { code: 'fr', label: 'Français', flag: '🇫🇷' },
  { code: 'zh', label: '中文', flag: '🇨🇳' },
];

export const translations = {
  // ─── Navigation ───────────────────────────────────────────────
  'Dashboard': { fr: 'Tableau de bord', zh: '主页' },
  'My Profile': { fr: 'Mon profil', zh: '我的资料' },
  'Move In/Out': { fr: 'Emménagement/Déménagement', zh: '搬入/搬出' },
  'My Packages': { fr: 'Mes colis', zh: '我的包裹' },
  'Gameroom': { fr: 'Salle de jeux', zh: '游戏室' },
  'Speakeasy': { fr: 'Speakeasy', zh: 'Speakeasy' },
  'AI Concierge': { fr: 'Conciergerie IA', zh: 'AI 礼宾' },
  'Board Oversight': { fr: 'Surveillance du conseil', zh: '董事会监督' },
  'Sign Out': { fr: 'Se déconnecter', zh: '退出登录' },
  'Language': { fr: 'Langue', zh: '语言' },

  // ─── Dashboard ────────────────────────────────────────────────
  'Good Morning': { fr: 'Bonjour', zh: '早上好' },
  'Good Afternoon': { fr: 'Bon après-midi', zh: '下午好' },
  'Good Evening': { fr: 'Bonsoir', zh: '晚上好' },
  'Unit': { fr: 'Unité', zh: '单元' },
  'Parking': { fr: 'Stationnement', zh: '停车位' },
  'None': { fr: 'Aucun', zh: '无' },
  'Updates & Alerts': { fr: 'Mises à jour et alertes', zh: '更新与通知' },
  'No new alerts': { fr: 'Aucune nouvelle alerte', zh: '暂无新通知' },
  'new notice': { fr: 'nouvelle notice', zh: '条新通知' },
  'new notices': { fr: 'nouvelles notices', zh: '条新通知' },
  'Packages': { fr: 'Colis', zh: '包裹' },
  'Check deliveries': { fr: 'Vérifier les livraisons', zh: '查看快递' },
  'Rent items now': { fr: 'Louer des articles', zh: '立即租用' },
  'Reserve a lounge': { fr: 'Réserver un salon', zh: '预订休息室' },
  'Request Maintenance': { fr: 'Demander une maintenance', zh: '申请维修' },
  'Report issues in your unit or common areas.': { fr: 'Signalez les problèmes dans votre unité ou les espaces communs.', zh: '报告您单元或公共区域的问题。' },
  'New Request': { fr: 'Nouvelle demande', zh: '新申请' },
  'Security Report': { fr: 'Rapport de sécurité', zh: '安全报告' },
  'Report parking violations or noise complaints.': { fr: 'Signaler les infractions de stationnement ou les plaintes de bruit.', zh: '举报违规停车或噪音投诉。' },
  'File Report': { fr: 'Déposer un rapport', zh: '提交报告' },
  'View Operations': { fr: 'Voir les opérations', zh: '查看操作' },

  // ─── Building Updates Feed ────────────────────────────────────
  'Building Updates': { fr: 'Mises à jour du bâtiment', zh: '楼宇通知' },
  'No active updates': { fr: 'Aucune mise à jour active', zh: '暂无活动通知' },
  'Emergency': { fr: 'Urgence', zh: '紧急' },
  'Maintenance': { fr: 'Maintenance', zh: '维修' },
  'General': { fr: 'Général', zh: '一般' },
  'Security': { fr: 'Sécurité', zh: '安全' },
  'Amenity': { fr: 'Commodité', zh: '设施' },
  'Announcement': { fr: 'Annonce', zh: '公告' },
  'Resolved': { fr: 'Résolu', zh: '已解决' },
  'Archive': { fr: 'Archiver', zh: '归档' },
  'View archived': { fr: 'Voir les archives', zh: '查看归档' },
  'Hide archived': { fr: 'Masquer les archives', zh: '隐藏归档' },
  'Archived notices': { fr: 'Notices archivées', zh: '已归档通知' },
  'No archived updates': { fr: 'Aucune mise à jour archivée', zh: '暂无归档通知' },

  // ─── Packages ─────────────────────────────────────────────────
  'My Packages': { fr: 'Mes colis', zh: '我的包裹' },
  'Deliveries for Unit': { fr: 'Livraisons pour l\'unité', zh: '单元包裹' },
  'Ready for Pickup': { fr: 'Prêt à récupérer', zh: '待取件' },
  'No active packages.': { fr: 'Aucun colis actif.', zh: '暂无待取包裹。' },
  'Package History': { fr: 'Historique des colis', zh: '包裹历史' },
  'No package history (last 30 days).': { fr: 'Aucun historique de colis (30 derniers jours).', zh: '暂无包裹记录（最近30天）。' },
  'Confirm Pick Up': { fr: 'Confirmer la récupération', zh: '确认取件' },
  'Confirming...': { fr: 'Confirmation...', zh: '确认中...' },
  'Picked Up': { fr: 'Récupéré', zh: '已取件' },
  'Ready': { fr: 'Prêt', zh: '待取' },
  'Picked up': { fr: 'Récupéré le', zh: '取件于' },
  'Delivered': { fr: 'Livré le', zh: '送达于' },
  'Package Details': { fr: 'Détails du colis', zh: '包裹详情' },
  'Recipient': { fr: 'Destinataire', zh: '收件人' },
  'Delivered on': { fr: 'Livré le', zh: '送达日期' },
  'Picked Up on': { fr: 'Récupéré le', zh: '取件日期' },
  'Notes': { fr: 'Notes', zh: '备注' },
  'No photo provided': { fr: 'Aucune photo fournie', zh: '无照片' },
  'Today': { fr: "Aujourd'hui", zh: '今天' },
  'Yesterday': { fr: 'Hier', zh: '昨天' },
  'View All History': { fr: 'Voir tout l\'historique', zh: '查看全部历史' },
  'Show Less': { fr: 'Afficher moins', zh: '收起' },
  'more packages': { fr: 'colis supplémentaires', zh: '个更多包裹' },
  'Unit Not Assigned': { fr: 'Unité non assignée', zh: '单元未分配' },
  'Your unit hasn\'t been assigned yet. Please contact management to complete your unit setup.': {
    fr: 'Votre unité n\'a pas encore été attribuée. Veuillez contacter la gestion.',
    zh: '您的单元尚未分配。请联系管理处完成设置。'
  },
  'Packages couldn\'t load right now': { fr: 'Les colis n\'ont pas pu être chargés', zh: '包裹暂时无法加载' },
  'Please wait a moment and try again.': { fr: 'Veuillez patienter et réessayer.', zh: '请稍后重试。' },
  'Try Again': { fr: 'Réessayer', zh: '重试' },
  'Please wait...': { fr: 'Veuillez patienter...', zh: '请稍候...' },
  'Reload Page': { fr: 'Recharger la page', zh: '重新加载' },
  'Loading your unit information...': { fr: 'Chargement des informations de votre unité...', zh: '正在加载单元信息...' },
  'Enjoy!': { fr: 'Profitez-en !', zh: '拿好！' },

  // ─── Speakeasy ────────────────────────────────────────────────
  'The Speakeasy': { fr: 'Le Speakeasy', zh: 'Speakeasy 酒吧' },
  'Exclusive amenity reservations': { fr: 'Réservations d\'équipements exclusifs', zh: '专属设施预订' },
  'Virtual Tour': { fr: 'Visite virtuelle', zh: '虚拟参观' },
  'Preview each space before booking': { fr: 'Prévisualisez chaque espace avant de réserver', zh: '预订前预览每个空间' },
  'New Reservation': { fr: 'Nouvelle réservation', zh: '新预订' },
  'Select Room': { fr: 'Sélectionner une salle', zh: '选择房间' },
  'Date': { fr: 'Date', zh: '日期' },
  'Pick a date': { fr: 'Choisir une date', zh: '选择日期' },
  'Start Time': { fr: 'Heure de début', zh: '开始时间' },
  'Select time': { fr: 'Sélectionner l\'heure', zh: '选择时间' },
  'Duration': { fr: 'Durée', zh: '时长' },
  'Hours': { fr: 'Heures', zh: '小时' },
  'Hour': { fr: 'Heure', zh: '小时' },
  'Select a start time first': { fr: 'Sélectionnez d\'abord une heure de début', zh: '请先选择开始时间' },
  'Request Reservation': { fr: 'Demander une réservation', zh: '申请预订' },
  'Submitting...': { fr: 'Envoi...', zh: '提交中...' },
  'Payment required upon approval.': { fr: 'Paiement requis à l\'approbation.', zh: '批准后需付款。' },
  'House Rules': { fr: 'Règles de la maison', zh: '使用规则' },
  'Your Reservations': { fr: 'Vos réservations', zh: '我的预订' },
  'Show Active': { fr: 'Afficher actifs', zh: '显示有效预订' },
  'Archived': { fr: 'Archivé', zh: '已归档' },
  'No upcoming reservations found.': { fr: 'Aucune réservation à venir.', zh: '暂无即将到来的预订。' },
  'No archived reservations.': { fr: 'Aucune réservation archivée.', zh: '暂无归档预订。' },
  'Pending reservation': { fr: 'Réservation en attente', zh: '待审核' },
  'Reservation approved': { fr: 'Réservation approuvée', zh: '已批准' },
  'Reservation Submitted': { fr: 'Réservation soumise', zh: '预订已提交' },
  'Please visit the front desk to complete payment and get your reservation approved.': {
    fr: 'Veuillez vous rendre à la réception pour compléter le paiement.',
    zh: '请前往前台完成付款并获得预订批准。'
  },
  'To modify or cancel this request, speak with the front desk.': {
    fr: 'Pour modifier ou annuler, parlez à la réception.',
    zh: '如需修改或取消，请联系前台。'
  },
  'Got it': { fr: 'Compris', zh: '好的' },
  'Reserved': { fr: 'Réservé', zh: '已预订' },

  // ─── Gameroom ─────────────────────────────────────────────────
  'Equipment rentals & fun': { fr: 'Location d\'équipement', zh: '设备租用' },
  'Tap to borrow': { fr: 'Appuyez pour emprunter', zh: '点击借用' },
  'Currently Rented': { fr: 'Actuellement loué', zh: '已被租用' },
  'YOUR ACTIVE RENTAL': { fr: 'VOTRE LOCATION ACTIVE', zh: '您的活跃租借' },
  'Not available — currently in use': { fr: 'Indisponible — en cours d\'utilisation', zh: '不可用 — 正在使用中' },
  'YOU ARE CURRENTLY RENTING THIS ITEM': { fr: 'VOUS LOUEZ CET ARTICLE', zh: '您正在租借此设备' },
  'Available for immediate rental.': { fr: 'Disponible pour location immédiate.', zh: '可立即租用。' },
  'Currently unavailable': { fr: 'Actuellement indisponible', zh: '当前不可用' },
  'Time Limit': { fr: 'Limite de temps', zh: '时间限制' },
  'Until Closing': { fr: 'Jusqu\'à la fermeture', zh: '至关闭时间' },
  'Return By': { fr: 'Retourner avant', zh: '归还时间' },
  'Cancel': { fr: 'Annuler', zh: '取消' },
  'Borrow Item': { fr: 'Emprunter l\'article', zh: '借用物品' },
  'Not Available': { fr: 'Non disponible', zh: '不可用' },
  'Requesting...': { fr: 'Demande...', zh: '请求中...' },
  'View Details →': { fr: 'Voir les détails →', zh: '查看详情 →' },
  'Waiting for approval': { fr: 'En attente d\'approbation', zh: '等待审批' },
  'Ready to pick up': { fr: 'Prêt à récupérer', zh: '可以取件' },
  'Rental in progress': { fr: 'Location en cours', zh: '租借中' },
  'Please proceed to the front desk.': { fr: 'Veuillez vous rendre à la réception.', zh: '请前往前台。' },
  'Expires in 10m': { fr: 'Expire dans 10 min', zh: '10分钟后过期' },
  'Show this screen to security to pick up your item.': {
    fr: 'Montrez cet écran à la sécurité pour récupérer votre article.',
    zh: '请将此屏幕出示给安保人员以取件。'
  },
  'Cancel Request': { fr: 'Annuler la demande', zh: '取消请求' },
  'Cancelling...': { fr: 'Annulation...', zh: '取消中...' },
  'Approved! Pick it up now.': { fr: 'Approuvé ! Récupérez-le maintenant.', zh: '已批准！请立即取件。' },
  'Start Timer': { fr: 'Démarrer le minuteur', zh: '开始计时' },
  'Return the item to the front desk when done. Security will process your return.': {
    fr: 'Retournez l\'article à la réception. La sécurité traitera votre retour.',
    zh: '完成后将物品归还前台，安保人员将处理您的归还。'
  },
  'No active rental': { fr: 'Aucune location active', zh: '无活跃租借' },

  // ─── Move Request ─────────────────────────────────────────────
  'Move In / Move Out': { fr: 'Emménagement / Déménagement', zh: '搬入 / 搬出' },
  'Request elevator reservation for your move': { fr: 'Demandez une réservation d\'ascenseur', zh: '申请搬运电梯预约' },
  'Submit Move Request': { fr: 'Soumettre une demande', zh: '提交搬运申请' },
  'Request Type *': { fr: 'Type de demande *', zh: '申请类型 *' },
  'Select move type': { fr: 'Sélectionner le type', zh: '选择类型' },
  'Move In': { fr: 'Emménagement', zh: '搬入' },
  'Move Out': { fr: 'Déménagement', zh: '搬出' },
  'Purpose of move *': { fr: 'Objet du déménagement *', zh: '搬运目的 *' },
  'Moving in furniture': { fr: 'Déménagement de meubles (entrée)', zh: '搬入家具' },
  'Moving out furniture': { fr: 'Déménagement de meubles (sortie)', zh: '搬出家具' },
  'Moving out of the building (permanent move-out)': { fr: 'Quitter le bâtiment (déménagement permanent)', zh: '永久搬出大楼' },
  'Date *': { fr: 'Date *', zh: '日期 *' },
  'Move Hours:': { fr: 'Heures de déménagement :', zh: '搬运时间：' },
  'Minimum Duration:': { fr: 'Durée minimale :', zh: '最短时间：' },
  '2 hours': { fr: '2 heures', zh: '2小时' },
  'Start Time *': { fr: 'Heure de début *', zh: '开始时间 *' },
  'Select start time': { fr: 'Sélectionner l\'heure de début', zh: '选择开始时间' },
  'Between 08:00 and 21:30': { fr: 'Entre 08h00 et 21h30', zh: '08:00 至 21:30' },
  'End Time *': { fr: 'Heure de fin *', zh: '结束时间 *' },
  'Select end time': { fr: 'Sélectionner l\'heure de fin', zh: '选择结束时间' },
  'Must be at least 2 hours after start': { fr: 'Doit être au moins 2 heures après le début', zh: '必须比开始时间晚至少2小时' },
  'Notes (Optional)': { fr: 'Notes (facultatif)', zh: '备注（可选）' },
  'Moving company name, truck size, special instructions, etc.': {
    fr: 'Nom de la société de déménagement, taille du camion, instructions spéciales, etc.',
    zh: '搬运公司名称、卡车尺寸、特殊说明等。'
  },
  'Submit Request': { fr: 'Soumettre la demande', zh: '提交申请' },
  'My Move Requests': { fr: 'Mes demandes de déménagement', zh: '我的搬运申请' },
  'Collapse': { fr: 'Réduire', zh: '收起' },
  'Show all': { fr: 'Tout afficher', zh: '显示全部' },
  'Clear all': { fr: 'Tout effacer', zh: '清除全部' },
  'Loading...': { fr: 'Chargement...', zh: '加载中...' },
  'No move requests yet': { fr: 'Aucune demande de déménagement', zh: '暂无搬运申请' },
  'Pending': { fr: 'En attente', zh: '待审核' },
  'Approved': { fr: 'Approuvé', zh: '已批准' },
  'Declined': { fr: 'Refusé', zh: '已拒绝' },
  'Decline Reason': { fr: 'Motif de refus', zh: '拒绝原因' },
  'Reviewed': { fr: 'Examiné', zh: '已审核' },
  'Delete Move Request': { fr: 'Supprimer la demande', zh: '删除申请' },
  'Are you sure you want to delete this move request? This action cannot be undone.': {
    fr: 'Êtes-vous sûr de vouloir supprimer cette demande ? Cette action est irréversible.',
    zh: '确定要删除此搬运申请吗？此操作无法撤销。'
  },
  'Delete': { fr: 'Supprimer', zh: '删除' },
  'Deleting...': { fr: 'Suppression...', zh: '删除中...' },
  'Clear All Move Requests': { fr: 'Effacer toutes les demandes', zh: '清除所有申请' },
  'Are you sure you want to clear all move requests? This action cannot be undone.': {
    fr: 'Êtes-vous sûr de vouloir effacer toutes les demandes ? Action irréversible.',
    zh: '确定要清除所有搬运申请吗？此操作无法撤销。'
  },
  'Clear All': { fr: 'Tout effacer', zh: '全部清除' },
  'Clearing...': { fr: 'Effacement...', zh: '清除中...' },
  'Move request sent!': { fr: 'Demande de déménagement envoyée !', zh: '搬运申请已发送！' },

  // ─── Profile ──────────────────────────────────────────────────
  'My Profile': { fr: 'Mon profil', zh: '我的资料' },
  'Manage your personal information and preferences': { fr: 'Gérez vos informations personnelles', zh: '管理您的个人信息和偏好' },
  'Save Changes': { fr: 'Enregistrer les modifications', zh: '保存更改' },
  'Save All Changes': { fr: 'Tout enregistrer', zh: '保存所有更改' },
  'Personal Information': { fr: 'Informations personnelles', zh: '个人信息' },
  'Full Name (Read-only)': { fr: 'Nom complet (lecture seule)', zh: '全名（只读）' },
  'Contact management to change your name': { fr: 'Contactez la gestion pour changer votre nom', zh: '联系管理处更改姓名' },
  'Preferred Name': { fr: 'Prénom préféré', zh: '常用名' },
  'Email': { fr: 'Courriel', zh: '电子邮件' },
  'Role (Read-only)': { fr: 'Rôle (lecture seule)', zh: '角色（只读）' },
  'Language Preference': { fr: 'Préférence de langue', zh: '语言偏好' },
  'Additional Occupants (Max 2)': { fr: 'Occupants supplémentaires (max 2)', zh: '额外居住者（最多2人）' },
  'Add': { fr: 'Ajouter', zh: '添加' },
  'No additional occupants added': { fr: 'Aucun occupant supplémentaire', zh: '未添加额外居住者' },
  'Contact Information': { fr: 'Informations de contact', zh: '联系信息' },
  'Primary Phone': { fr: 'Téléphone principal', zh: '主要电话' },
  'Secondary Phone': { fr: 'Téléphone secondaire', zh: '次要电话' },
  'Emergency Contact Name': { fr: 'Nom du contact d\'urgence', zh: '紧急联系人姓名' },
  'Emergency Contact Phone': { fr: 'Téléphone du contact d\'urgence', zh: '紧急联系人电话' },
  'Residency Information': { fr: 'Informations de résidence', zh: '居住信息' },
  'Unit Number': { fr: 'Numéro d\'unité', zh: '单元编号' },
  'Unit Number (Locked)': { fr: 'Numéro d\'unité (verrouillé)', zh: '单元编号（已锁定）' },
  'Unit number cannot be changed. Contact management if needed.': {
    fr: 'Le numéro d\'unité ne peut pas être modifié. Contactez la gestion si nécessaire.',
    zh: '单元编号不可更改。如需更改请联系管理处。'
  },
  'Residency Type': { fr: 'Type de résidence', zh: '居住类型' },
  'Owner': { fr: 'Propriétaire', zh: '业主' },
  'Tenant': { fr: 'Locataire', zh: '租客' },
  'Staff': { fr: 'Personnel', zh: '员工' },
  'Move-in Date': { fr: 'Date d\'emménagement', zh: '入住日期' },
  'Lease End Date (if applicable)': { fr: 'Date de fin de bail (si applicable)', zh: '租约到期日（如适用）' },
  'Vehicles': { fr: 'Véhicules', zh: '车辆' },
  'Add Vehicle': { fr: 'Ajouter un véhicule', zh: '添加车辆' },
  'No vehicles registered. Click "Add Vehicle" to register one.': {
    fr: 'Aucun véhicule enregistré. Cliquez sur "Ajouter un véhicule".',
    zh: '未登记车辆。点击"添加车辆"以登记。'
  },
  'Plate Number': { fr: 'Numéro de plaque', zh: '车牌号' },
  'Region': { fr: 'Région', zh: '地区' },
  'Vehicle Type': { fr: 'Type de véhicule', zh: '车辆类型' },
  'Parking Spot (Read-only)': { fr: 'Place de stationnement (lecture seule)', zh: '停车位（只读）' },
  'No spot assigned': { fr: 'Aucune place assignée', zh: '未分配车位' },
  'Submit a parking verification request to change this.': {
    fr: 'Soumettez une demande de vérification de stationnement.',
    zh: '提交停车位验证申请以更改此信息。'
  },
  'Preferences': { fr: 'Préférences', zh: '偏好设置' },
  'Notification Settings': { fr: 'Paramètres de notification', zh: '通知设置' },
  'Maintenance Updates': { fr: 'Mises à jour de maintenance', zh: '维修更新' },
  'Package Notifications': { fr: 'Notifications de colis', zh: '包裹通知' },
  'Announcements': { fr: 'Annonces', zh: '公告' },
  'Preferred Contact Method': { fr: 'Méthode de contact préférée', zh: '首选联系方式' },
  'Phone': { fr: 'Téléphone', zh: '电话' },
  'SMS': { fr: 'SMS', zh: '短信' },
  'Documents': { fr: 'Documents', zh: '文件' },
  'Lease Document': { fr: 'Document de bail', zh: '租约文件' },
  'Insurance Info': { fr: 'Informations d\'assurance', zh: '保险信息' },
  'View': { fr: 'Voir', zh: '查看' },
  'Profile saved successfully': { fr: 'Profil enregistré avec succès', zh: '资料已成功保存' },
  'Pending Approval': { fr: 'Approbation en attente', zh: '待审批' },
  'Upload your lease and insurance documents to complete your profile. Full access will be granted after approval.': {
    fr: 'Téléversez vos documents pour compléter votre profil. L\'accès complet sera accordé après approbation.',
    zh: '上传您的租约和保险文件以完善资料。批准后将获得完整访问权限。'
  },
  'Application Rejected': { fr: 'Demande rejetée', zh: '申请已拒绝' },
  'Loading profile...': { fr: 'Chargement du profil...', zh: '加载资料中...' },

  // ─── Speakeasy House Rules ────────────────────────────────────
  'Strict 11:00 PM curfew (Residential floors)': { fr: 'Couvre-feu strict à 23h (étages résidentiels)', zh: '严格执行晚上11点宵禁（住宅楼层）' },
  'No smoking/vaping ($1000 fine)': { fr: 'Pas de cigarette/vapotage (amende 1000$)', zh: '禁止吸烟/电子烟（罚款1000元）' },
  'Guests restricted to room ($250 fine for roaming)': { fr: 'Invités limités à la salle (amende 250$ pour déambulation)', zh: '访客限于预订房间（擅自离开罚款250元）' },
  'Cleaning required before return': { fr: 'Nettoyage requis avant le retour', zh: '归还前需清洁房间' },
  'No loud music or DJ allowed': { fr: 'Musique forte ou DJ interdits', zh: '禁止大声播放音乐或DJ' },
  'Pre-inspection & Debit deposit required': { fr: 'Pré-inspection et dépôt débit requis', zh: '需要预检和借记押金' },
  'Max 4 hours (extra $50/hr)': { fr: 'Max 4 heures (50$/heure supplémentaire)', zh: '最多4小时（超时每小时加收50元）' },
  'Select a start time first': { fr: 'Sélectionnez d\'abord une heure de début', zh: '请先选择开始时间' },
  'Virtual Tour': { fr: 'Visite virtuelle', zh: '虚拟参观' },
  'Preview each space before booking': { fr: 'Prévisualisez chaque espace avant de réserver', zh: '预订前预览每个空间' },
  'View all photos →': { fr: 'Voir toutes les photos →', zh: '查看所有照片 →' },

  // ─── Virtual Tour room descriptions ──────────────────────────
  'An intimate lounge with vintage-inspired decor, perfect for private gatherings.': {
    fr: 'Un salon intime au décor vintage, parfait pour des rassemblements privés.',
    zh: '充满复古风情的私密休息室，非常适合私人聚会。'
  },
  'A cozy TV lounge with comfortable seating, ideal for movie nights.': {
    fr: 'Un salon TV confortable, idéal pour les soirées cinéma.',
    zh: '舒适的电视休息室，配有舒适的座位，非常适合电影之夜。'
  },
  'A stylish dining space with integrated entertainment — ideal for dinner and a show.': {
    fr: 'Un espace repas élégant avec divertissement intégré — idéal pour dîner et regarder un film.',
    zh: '时尚的餐饮空间，配备娱乐设施——非常适合晚餐和观影。'
  },
  'A spacious open-plan living and dining area with panoramic views.': {
    fr: 'Un espace de vie et de repas ouvert et spacieux avec des vues panoramiques.',
    zh: '宽敞的开放式起居和餐饮区，享有全景视野。'
  },
  'TV Room (2nd floor)': { fr: 'Salon TV (2e étage)', zh: '电视室（2楼）' },
  'Dining room with TV (2nd floor)': { fr: 'Salle à manger avec TV (2e étage)', zh: '带电视的餐厅（2楼）' },
  'Living and Dining Room (3rd floor)': { fr: 'Salon et salle à manger (3e étage)', zh: '客厅和餐厅（3楼）' },

  // ─── AI Concierge ─────────────────────────────────────────────
  'Your AI-powered building concierge': { fr: 'Votre concierge IA', zh: '您的AI大楼礼宾助手' },
  'Ask me anything about your building, amenities, or policies.': {
    fr: 'Posez-moi des questions sur votre immeuble, les commodités ou les règles.',
    zh: '向我询问任何关于大楼、设施或规定的问题。'
  },
  'Type your message...': { fr: 'Tapez votre message...', zh: '请输入您的消息...' },
  'Send': { fr: 'Envoyer', zh: '发送' },
  'Thinking...': { fr: 'Réflexion...', zh: '思考中...' },
  'What are the pool hours?': { fr: 'Quelles sont les heures de la piscine?', zh: '泳池开放时间是什么？' },
  'How do I book the Speakeasy?': { fr: 'Comment réserver le Speakeasy?', zh: '如何预订Speakeasy？' },
  'What is the guest policy?': { fr: 'Quelle est la politique pour les invités?', zh: '访客政策是什么？' },
  'How do I submit a maintenance request?': { fr: 'Comment soumettre une demande de maintenance?', zh: '如何提交维修申请？' },
  'Suggested questions': { fr: 'Questions suggérées', zh: '建议问题' },
  'New conversation': { fr: 'Nouvelle conversation', zh: '新对话' },
  'Something went wrong. Please try again.': { fr: 'Une erreur s\'est produite. Réessayez.', zh: '出现错误，请重试。' },

  // ─── BuildingUpdatesFeed ──────────────────────────────────────
  'Updates & Alerts': { fr: 'Mises à jour et alertes', zh: '更新与通知' },
  'Archive All': { fr: 'Tout archiver', zh: '全部归档' },
  'Archived': { fr: 'Archivés', zh: '已归档' },
  'All': { fr: 'Tout', zh: '全部' },
  'Updates': { fr: 'Mises à jour', zh: '更新' },
  'No updates at this time.': { fr: 'Aucune mise à jour pour le moment.', zh: '暂无更新。' },
  'No active emergencies.': { fr: 'Aucune urgence active.', zh: '暂无紧急通知。' },
  'No building updates.': { fr: 'Aucune mise à jour du bâtiment.', zh: '暂无楼宇更新。' },
  'Archive All Updates': { fr: 'Archiver toutes les mises à jour', zh: '归档所有更新' },
  'Are you sure you want to archive all': { fr: 'Êtes-vous sûr de vouloir archiver tous les', zh: '确定要归档所有' },
  'active updates? You can restore them later from the Archived section.': {
    fr: 'mises à jour actives ? Vous pouvez les restaurer depuis la section Archivés.',
    zh: '条活动更新吗？您可以稍后从归档部分恢复它们。'
  },
  'Archiving...': { fr: 'Archivage...', zh: '归档中...' },

  // ─── Move In/Out (additional) ─────────────────────────────────
  'only': { fr: 'uniquement', zh: '仅限' },
  'Move Hours: 08:00–22:00 only': { fr: 'Heures de déménagement : 08h00–22h00 uniquement', zh: '搬运时间：仅限08:00–22:00' },
  'Minimum Duration: 2 hours': { fr: 'Durée minimale : 2 heures', zh: '最短时长：2小时' },

  // ─── Profile (additional) ─────────────────────────────────────
  'No file chosen': { fr: 'Aucun fichier sélectionné', zh: '未选择文件' },
  'Full Name (Read-only)': { fr: 'Nom complet (lecture seule)', zh: '全名（只读）' },
  'Relationship (e.g., Spouse, Roommate)': { fr: 'Relation (ex. Conjoint, Colocataire)', zh: '关系（例如：配偶、室友）' },
  'ABC 1234': { fr: 'ABC 1234', zh: 'ABC 1234' },
  'ON, CA, NY': { fr: 'QC, ON, NY', zh: 'ON, QC, NY' },
  'Sedan, SUV, Truck': { fr: 'Berline, VUS, Camion', zh: '轿车、SUV、卡车' },
  '(555) 123-4567': { fr: '(555) 123-4567', zh: '(555) 123-4567' },
  '(555) 987-6543': { fr: '(555) 987-6543', zh: '(555) 987-6543' },
  'Jane Doe': { fr: 'Marie Dupont', zh: '张三' },
  '(555) 111-2222': { fr: '(555) 111-2222', zh: '(555) 111-2222' },
  'Vehicle': { fr: 'Véhicule', zh: '车辆' },
  'Parking Space Verification': { fr: 'Vérification de la place de stationnement', zh: '停车位验证' },
  'Current Parking Spot on File': { fr: 'Place de stationnement actuelle enregistrée', zh: '当前档案中的停车位' },
  'To change your parking space, submit a verification request below.': {
    fr: 'Pour changer votre place, soumettez une demande de vérification ci-dessous.',
    zh: '如需更改停车位，请在下方提交验证申请。'
  },
  'Request Parking Space Update': { fr: 'Demander une mise à jour de la place de stationnement', zh: '申请更新停车位' },
  'None on file': { fr: 'Aucun au dossier', zh: '档案中无记录' },
  'Awaiting Management Approval': { fr: 'En attente d\'approbation de la gestion', zh: '等待管理处审批' },
  'Rejected': { fr: 'Refusé', zh: '已拒绝' },
  'Request Pending Review': { fr: 'Demande en attente d\'examen', zh: '申请待审核' },
  'You have an active request for spot': { fr: 'Vous avez une demande active pour la place', zh: '您有一个待处理的停车位申请：' },
  'You cannot submit another until it is reviewed.': { fr: 'Vous ne pouvez pas en soumettre une autre avant qu\'elle soit examinée.', zh: '在审核完成前，您无法提交新申请。' },
  'Request History': { fr: 'Historique des demandes', zh: '申请记录' },
  'Requested': { fr: 'Demandé', zh: '申请车位' },
  'Previous': { fr: 'Précédent', zh: '原车位' },
  'Submitted': { fr: 'Soumis', zh: '提交于' },
  'View Proof Document': { fr: 'Voir le document justificatif', zh: '查看证明文件' },
  'Rejection reason': { fr: 'Motif de rejet', zh: '拒绝原因' },
  'Upload Proof of Parking Space': { fr: 'Téléverser une preuve de place de stationnement', zh: '上传停车位证明' },
  'Requested Parking Spot': { fr: 'Place de stationnement demandée', zh: '申请停车位' },
  'e.g. P-101, B2-45': { fr: 'ex. P-101, B2-45', zh: '例如：P-101、B2-45' },
  'Note (Optional)': { fr: 'Note (facultatif)', zh: '备注（可选）' },
  'Any additional context for management...': { fr: 'Tout contexte supplémentaire pour la gestion...', zh: '为管理处提供任何补充说明...' },
  'Proof Document': { fr: 'Document justificatif', zh: '证明文件' },
  'Accepted: PDF, JPG, PNG, WEBP': { fr: 'Accepté : PDF, JPG, PNG, WEBP', zh: '支持格式：PDF、JPG、PNG、WEBP' },
  'Click to upload proof document': { fr: 'Cliquez pour téléverser un document justificatif', zh: '点击上传证明文件' },
  'Submit Verification Request': { fr: 'Soumettre la demande de vérification', zh: '提交验证申请' },

  // ─── Common / Shared ──────────────────────────────────────────
  'Save': { fr: 'Enregistrer', zh: '保存' },
  'Close': { fr: 'Fermer', zh: '关闭' },
  'Dismiss': { fr: 'Ignorer', zh: '关闭' },
  'Confirm': { fr: 'Confirmer', zh: '确认' },
  'Submit': { fr: 'Soumettre', zh: '提交' },
  'Back': { fr: 'Retour', zh: '返回' },
  'Error': { fr: 'Erreur', zh: '错误' },
  'Success': { fr: 'Succès', zh: '成功' },
  'Yes': { fr: 'Oui', zh: '是' },
  'No': { fr: 'Non', zh: '否' },
  'RSVP': { fr: 'RSVP', zh: '报名' },

  // Appearance / Dark mode
  'Appearance': { fr: 'Apparence', zh: '外观' },
  'Color Scheme': { fr: 'Schéma de couleurs', zh: '颜色模式' },
  'Light': { fr: 'Clair', zh: '浅色' },
  'Dark': { fr: 'Sombre', zh: '深色' },
  'System Default': { fr: 'Système par défaut', zh: '跟随系统' },
  'Changes apply immediately and are saved to this device.': { fr: 'Les changements s\'appliquent immédiatement et sont enregistrés sur cet appareil.', zh: '更改立即生效并保存在此设备上。' },

  // Delete account
  'Account': { fr: 'Compte', zh: '账户' },
  'Deleting your account will remove your profile data and access. This action cannot be undone.': { fr: 'La suppression de votre compte supprimera vos données de profil et votre accès. Cette action est irréversible.', zh: '删除您的账户将移除您的个人资料和访问权限，此操作无法撤销。' },
  'Delete Account': { fr: 'Supprimer le compte', zh: '删除账户' },
  'This action is permanent and cannot be undone. Your profile, documents, and all associated data will be marked for deletion. You will be signed out immediately.': { fr: 'Cette action est permanente et irréversible. Votre profil, vos documents et toutes les données associées seront marqués pour suppression. Vous serez déconnecté immédiatement.', zh: '此操作是永久性的，无法撤销。您的个人资料、文件和所有相关数据将被标记为删除。您将立即退出登录。' },
  'Type DELETE to confirm': { fr: 'Tapez SUPPRIMER pour confirmer', zh: '输入 DELETE 以确认' },
  'Cancel': { fr: 'Annuler', zh: '取消' },
  'Permanently Delete': { fr: 'Supprimer définitivement', zh: '永久删除' },

  // Maintenance tab label (bottom tabs)
  'Maintenance': { fr: 'Maintenance', zh: '维修' },
};

/**
 * Translate a key into the target language.
 * Falls back to English (the key itself) if the translation is missing.
 */
export function t(key, lang = 'en') {
  if (!key) return key;
  if (lang === 'en') return key;
  const entry = translations[key];
  if (!entry) return key;
  return entry[lang] || key;
}