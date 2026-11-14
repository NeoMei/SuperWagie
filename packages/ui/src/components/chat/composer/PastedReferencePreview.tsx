import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import type { ComposerReference } from './composerReferences';

export function PastedReferencePreview(props: { reference: ComposerReference | null; onClose: () => void; onRemove: () => void }) {
    const { t } = useI18n();
    return <Dialog open={Boolean(props.reference)} onOpenChange={(open) => { if (!open) props.onClose(); }}>
        <DialogContent className="max-w-2xl">
            <DialogHeader>
                <DialogTitle>{props.reference?.title}</DialogTitle>
                <DialogDescription>{t('references.pasted.description')}</DialogDescription>
            </DialogHeader>
            <pre dir="auto" className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words typography-meta">{props.reference?.contextText}</pre>
            <DialogFooter>
                <Button variant="ghost" onClick={props.onRemove}>{t('references.pasted.remove')}</Button>
                <Button variant="default" onClick={props.onClose}>{t('references.pasted.close')}</Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>;
}
