import React, { useState, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Car, Upload, FileText, Clock, CheckCircle, XCircle, AlertTriangle, Loader2, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { useLanguage } from '@/lib/LanguageContext';

const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

function StatusBadge({ status }) {
  const { t } = useLanguage();
  if (status === 'pending') return (
    <Badge className="bg-amber-100 text-amber-800 border-amber-200">
      <Clock className="w-3 h-3 mr-1" /> {t('Awaiting Management Approval')}
    </Badge>
  );
  if (status === 'approved') return (
    <Badge className="bg-green-100 text-green-800 border-green-200">
      <CheckCircle className="w-3 h-3 mr-1" /> {t('Approved')}
    </Badge>
  );
  if (status === 'rejected') return (
    <Badge className="bg-red-100 text-red-800 border-red-200">
      <XCircle className="w-3 h-3 mr-1" /> {t('Rejected')}
    </Badge>
  );
  return null;
}

export default function ParkingProofRequestSection({ user, profile }) {
  const { t } = useLanguage();
  const [requestedSpot, setRequestedSpot] = useState('');
  const [residentNote, setResidentNote] = useState('');
  const [proofFile, setProofFile] = useState(null);
  const [proofFileName, setProofFileName] = useState('');
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [fileError, setFileError] = useState('');
  const fileInputRef = useRef(null);
  const queryClient = useQueryClient();

  const currentParkingSpot = profile?.vehicles?.[0]?.parking_spot || profile?.parking_spot || '';

  const { data: requests = [] } = useQuery({
    queryKey: ['parking-proof-requests', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      return await base44.entities.ParkingProofRequest.filter(
        { resident_user_id: user.id },
        '-created_date',
        10
      );
    },
    enabled: !!user?.id
  });

  const pendingRequest = requests.find(r => r.status === 'pending');

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    setFileError('');
    if (!file) return;
    if (!ALLOWED_TYPES.includes(file.type)) {
      setFileError('Only PDF, JPG, PNG, or WEBP files are allowed.');
      return;
    }
    setProofFile(file);
    setProofFileName(file.name);
  };

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!proofFile) throw new Error('A proof document is required.');
      if (!requestedSpot.trim()) throw new Error('Please enter the requested parking spot.');

      setUploadingDoc(true);
      let proof_document_url;
      try {
        const result = await base44.integrations.Core.UploadFile({ file: proofFile });
        proof_document_url = result.file_url;
      } finally {
        setUploadingDoc(false);
      }

      const unitNumber = profile?.unit_number || '';
      const towerGuess = unitNumber.toString().startsWith('1') ? 'E' : 'W';

      await base44.entities.ParkingProofRequest.create({
        resident_user_id: user.id,
        resident_name: profile?.full_name || user.full_name || '',
        unit_number: unitNumber,
        tower: towerGuess,
        current_parking_spot: currentParkingSpot,
        requested_parking_spot: requestedSpot.trim(),
        resident_note: residentNote.trim(),
        proof_document_url,
        proof_document_name: proofFileName,
        status: 'pending'
      });

      // Notify management
      await base44.entities.Notification.create({
        title: 'New Parking Space Verification Request',
        message: `${profile?.full_name || user.full_name} (Unit ${unitNumber}) has submitted a parking space verification request for spot ${requestedSpot.trim()}.`,
        type: 'announcement',
        target_role: 'property_management'
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['parking-proof-requests'] });
      toast.success('Parking verification request submitted. Awaiting management approval.');
      setShowForm(false);
      setRequestedSpot('');
      setResidentNote('');
      setProofFile(null);
      setProofFileName('');
    },
    onError: (err) => {
      toast.error(err.message || 'Failed to submit request');
    }
  });

  const handleSubmit = () => {
    if (!proofFile) {
      setFileError('A proof document is required to submit this request.');
      return;
    }
    submitMutation.mutate();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Car className="w-5 h-5" />
          {t('Parking Space Verification')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Current Parking */}
        <div className="p-3 bg-zinc-50 rounded-lg">
          <p className="text-xs text-zinc-500 uppercase tracking-wider font-medium mb-1">{t('Current Parking Spot on File')}</p>
          <p className="font-semibold text-zinc-800">{currentParkingSpot || t('None on file')}</p>
          <p className="text-xs text-zinc-400 mt-1">{t('To change your parking space, submit a verification request below.')}</p>
        </div>

        {/* Pending request banner */}
        {pendingRequest && (
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2">
            <Clock className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-amber-900">{t('Request Pending Review')}</p>
              <p className="text-xs text-amber-700 mt-0.5">{t('You have an active request for spot')} <strong>{pendingRequest.requested_parking_spot}</strong>. {t('You cannot submit another until it is reviewed.')}</p>
            </div>
          </div>
        )}

        {/* Request history */}
        {requests.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-semibold text-zinc-700">{t('Request History')}</p>
            {requests.map(req => (
              <div key={req.id} className="p-3 border border-zinc-200 rounded-lg space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{t('Requested')}: <span className="font-bold">{req.requested_parking_spot}</span></p>
                    {req.current_parking_spot && (
                      <p className="text-xs text-zinc-500">{t('Previous')}: {req.current_parking_spot}</p>
                    )}
                  </div>
                  <StatusBadge status={req.status} />
                </div>
                <div className="flex items-center gap-4 text-xs text-zinc-400">
                  <span>{t('Submitted')} {format(new Date(req.created_date), 'MMM d, yyyy')}</span>
                  {req.reviewed_at && <span>{t('Reviewed')} {format(new Date(req.reviewed_at), 'MMM d, yyyy')}</span>}
                </div>
                {req.proof_document_url && (
                  <a
                    href={req.proof_document_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                  >
                    <FileText className="w-3 h-3" />
                    {req.proof_document_name || t('View Proof Document')}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
                {req.status === 'rejected' && req.rejection_reason && (
                  <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
                    <strong>{t('Rejection reason')}:</strong> {req.rejection_reason}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Request button / form */}
        {!pendingRequest && !showForm && (
          <Button variant="outline" onClick={() => setShowForm(true)} className="w-full">
            <Car className="w-4 h-4 mr-2" />
            {t('Request Parking Space Update')}
          </Button>
        )}

        {showForm && !pendingRequest && (
          <div className="space-y-4 p-4 border border-zinc-200 rounded-lg bg-zinc-50/50">
            <p className="text-sm font-semibold text-zinc-800">{t('Upload Proof of Parking Space')}</p>

            <div>
              <Label>{t('Requested Parking Spot')} <span className="text-red-500">*</span></Label>
              <Input
                placeholder={t('e.g. P-101, B2-45')}
                value={requestedSpot}
                onChange={(e) => setRequestedSpot(e.target.value)}
                className="mt-1"
              />
            </div>

            <div>
              <Label>{t('Note (Optional)')}</Label>
              <Textarea
                placeholder={t('Any additional context for management...')}
                value={residentNote}
                onChange={(e) => setResidentNote(e.target.value)}
                rows={2}
                className="mt-1 resize-none"
              />
            </div>

            <div>
              <Label>{t('Proof Document')} <span className="text-red-500">*</span></Label>
              <p className="text-xs text-zinc-500 mb-1">{t('Accepted: PDF, JPG, PNG, WEBP')}</p>
              <div
                className={`border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ${proofFile ? 'border-green-400 bg-green-50' : 'border-zinc-300 hover:border-zinc-400'}`}
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept=".pdf,.jpg,.jpeg,.png,.webp"
                  onChange={handleFileChange}
                />
                {proofFile ? (
                  <div className="flex items-center justify-center gap-2 text-green-700">
                    <FileText className="w-4 h-4" />
                    <span className="text-sm font-medium">{proofFileName}</span>
                  </div>
                ) : (
                  <div className="flex items-center justify-center gap-2 text-zinc-400">
                    <Upload className="w-4 h-4" />
                    <span className="text-sm">{t('Click to upload proof document')}</span>
                  </div>
                )}
              </div>
              {fileError && (
                <p className="text-xs text-red-600 mt-1 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> {fileError}
                </p>
              )}
            </div>

            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => { setShowForm(false); setFileError(''); setProofFile(null); setProofFileName(''); }}
                disabled={submitMutation.isPending || uploadingDoc}
              >
                {t('Cancel')}
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={submitMutation.isPending || uploadingDoc || !requestedSpot.trim()}
                className="flex-1"
              >
                {(submitMutation.isPending || uploadingDoc) ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> {t('Submitting...')}</>
                ) : (
                  t('Submit Verification Request')
                )}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}